// Example requests people can make of an assistant connected to HSA Locker. One list feeds the MCP
// server instructions, the get_started tool and the "Try asking" list in Settings.
// Every example must be doable with the MCP server's tools (src/worker/mcp.ts).

export interface ExamplePrompt {
  /** What to say, written the way a person would ask. <angle brackets> mark what to fill in. */
  prompt: string;
  /** Why it's worth asking, in a few words. */
  why: string;
}

export const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  {
    prompt:
      'How much can I reimburse myself from my HSA right now, and which receipts make that up?',
    why: 'The amount to withdraw, itemized.',
  },
  {
    prompt:
      'I withdrew <amount> from my HSA on <date>. Find reimbursable receipts that add up to it and record the reimbursement once I confirm.',
    why: 'Matches a withdrawal to receipts.',
  },
  {
    prompt: 'Go through my review queue: tell me what’s wrong with each item and what you’d fix.',
    why: 'Clears Review faster.',
  },
  {
    prompt: 'What did we spend on <person>’s care in <year>, by category and provider?',
    why: 'Year-end totals, no spreadsheet.',
  },
  {
    prompt:
      'Find receipts paid with my HSA card ending <last 4> that still count as reimbursable, and mark them not claimable after I check the list.',
    why: 'Avoids reimbursing twice.',
  },
  {
    prompt: 'Compare <year> with the year before: documented, reimbursed and still reimbursable.',
    why: 'Where you stand, year over year.',
  },
  {
    prompt: 'List my oldest reimbursable receipts so I can reimburse those first.',
    why: 'Old receipts are easy to forget.',
  },
  {
    prompt: 'Which providers did we pay the most in <year>?',
    why: 'Spot your biggest costs.',
  },
];

/** The ready-made MCP prompts, for listing alongside the examples. */
export const MCP_PROMPTS: { name: string; title: string; does: string }[] = [
  {
    name: 'record_reimbursement',
    title: 'Record a reimbursement',
    does: 'Picks reimbursable receipts for a withdrawal, confirms the list and total, then records it.',
  },
  {
    name: 'clear_review_queue',
    title: 'Work through Review',
    does: 'Explains each flagged item, proposes fixes, and approves them once you agree.',
  },
  {
    name: 'year_in_review',
    title: 'Year in review',
    does: 'Totals for a year by person, category and provider, plus what’s still reimbursable.',
  },
  {
    name: 'hsa_card_check',
    title: 'Check HSA card receipts',
    does: 'Finds receipts paid with your HSA card that still count as reimbursable and marks them not claimable.',
  },
];
