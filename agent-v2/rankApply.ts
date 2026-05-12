/**
 * Agent V2 LLM ranker — Phase C.
 *
 * Reads the Claude session's JSON output and updates
 * agent_entry_decisions with llm_thesis / llm_rank / llm_confidence.
 * Writes one agent_llm_calls row per decision for cost / latency /
 * parse-failure auditing.
 *
 * Expected LLM output schema (enforced in the prompt — see rank.sh):
 *   [
 *     { "decisionId": "uuid", "rank": 1, "thesis": "...", "confidence": 0.8 },
 *     ...
 *   ]
 *
 * Hard rules enforced here:
 *   - LLM cannot promote skip → enter. UPDATE WHERE decision='enter'
 *     AND entered_position_id IS NULL.
 *   - Prompt + response truncated to 4 kb each in the audit table.
 *   - On parse / read failure: one fallback_used audit row, llm_thesis
 *     left NULL so the executor falls back to consensus order.
 *
 * Run:
 *   npx tsx --env-file=.env agent-v2/rankApply.ts \
 *     --input /tmp/agent-v2-rank-input.json \
 *     --output /tmp/agent-v2-rank-output.json \
 *     [--duration-ms 12345] [--status ok]
 */
import { readFile } from 'node:fs/promises';
import { pool } from './db';

const MODEL_NAME = 'claude-opus-4-7';
const MAX_TRUNC = 4_000;

type Status = 'ok' | 'timeout' | 'error' | 'parse_fail' | 'fallback_used';

interface RankedItem {
  decisionId?: string;
  rank?: number;
  thesis?: string;
  confidence?: number;
}

function parseArgs(): {
  input: string;
  output: string;
  durationMs: number;
  status: Status;
} {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  return {
    input: get('--input', '/tmp/agent-v2-rank-input.json')!,
    output: get('--output', '/tmp/agent-v2-rank-output.json')!,
    durationMs: Number(get('--duration-ms', '0')) || 0,
    status: (get('--status', 'ok') as Status) || 'ok',
  };
}

function truncate(text: string | undefined, max = MAX_TRUNC): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

async function recordAudit(args: {
  decisionId: string | null;
  promptTrunc: string;
  responseTrunc: string;
  durationMs: number;
  status: Status;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO agent_llm_calls
         (decision_id, model, prompt_truncated, response_truncated, duration_ms, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        args.decisionId,
        MODEL_NAME,
        args.promptTrunc,
        args.responseTrunc,
        args.durationMs,
        args.status,
      ],
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[agent-v2-rank-apply] audit insert: ${msg}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  let promptText = '';
  try {
    promptText = await readFile(args.input, 'utf8');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[agent-v2-rank-apply] cannot read input ${args.input}: ${msg}`);
  }

  let outputText = '';
  let parsed: RankedItem[] | null = null;
  try {
    outputText = await readFile(args.output, 'utf8');
    const json = JSON.parse(outputText) as unknown;
    if (Array.isArray(json)) parsed = json as RankedItem[];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[agent-v2-rank-apply] cannot read/parse ${args.output}: ${msg}`);
  }

  const promptTrunc = truncate(promptText);
  const responseTrunc = truncate(outputText);

  if (!parsed || parsed.length === 0) {
    await recordAudit({
      decisionId: null,
      promptTrunc,
      responseTrunc,
      durationMs: args.durationMs,
      status: args.status === 'ok' ? 'parse_fail' : args.status,
    });
    console.log(
      `[agent-v2-rank-apply] no parseable items — executor will fall back to consensus order`,
    );
    await pool.end();
    process.exit(0);
  }

  let updated = 0;
  let skipped = 0;
  for (const item of parsed) {
    if (!item.decisionId || typeof item.decisionId !== 'string') {
      skipped++;
      continue;
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (typeof item.thesis === 'string' && item.thesis.length > 0) {
      fields.push(`llm_thesis = $${idx++}`);
      values.push(item.thesis.slice(0, 240));
    }
    if (typeof item.rank === 'number' && Number.isFinite(item.rank)) {
      fields.push(`llm_rank = $${idx++}`);
      values.push(Math.max(1, Math.floor(item.rank)));
    }
    if (typeof item.confidence === 'number' && Number.isFinite(item.confidence)) {
      fields.push(`llm_confidence = $${idx++}`);
      values.push(Math.max(0, Math.min(1, item.confidence)));
    }
    if (fields.length === 0) {
      skipped++;
      continue;
    }
    values.push(item.decisionId);

    try {
      // Hard rule: only touch rows still eligible. The LLM cannot
      // resurrect skipped decisions or re-open already-opened ones.
      await pool.query(
        `UPDATE agent_entry_decisions
            SET ${fields.join(', ')}
          WHERE id = $${idx}
            AND decision = 'enter'
            AND entered_position_id IS NULL`,
        values,
      );
      updated++;
      await recordAudit({
        decisionId: item.decisionId,
        promptTrunc,
        responseTrunc,
        durationMs: args.durationMs,
        status: args.status,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[agent-v2-rank-apply] update ${item.decisionId}: ${msg}`);
      await recordAudit({
        decisionId: item.decisionId,
        promptTrunc,
        responseTrunc,
        durationMs: args.durationMs,
        status: 'error',
      });
    }
  }

  console.log(
    `[agent-v2-rank-apply] updated=${updated} skipped=${skipped} from ${parsed.length} items`,
  );
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[agent-v2-rank-apply] fatal: ${msg}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
