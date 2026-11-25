/** 提问工具名（DSH 侧 `ask_user_question`）。 */
export declare const ASK_USER_QUESTION_TOOL: 'ask_user_question';

/** Paseo 提问卡的一题（`ProviderPermissionRequest.input.questions[]` 的成员）。 */
export interface PaseoQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  allowOther?: boolean;
  allowEmpty?: boolean;
  placeholder?: string;
}

/** DSH 的 `AskUserQuestionItem`（只声明用到的字段）。 */
export interface DshQuestionItem {
  id?: string;
  question?: string;
  detail?: string;
  header?: string;
  options?: Array<{ label?: string; description?: string }>;
  multiSelect?: boolean;
  intent?: any;
}

/** `$events/result` 的 outcome。 */
export type DshQuestionOutcome =
  | { kind: 'result'; value: { answers: Array<{ id: string; selected: string[]; custom?: string }> } }
  | { kind: 'rejected'; error: { name: string; message: string; code?: string } }
  | { kind: 'next' };

export function mapQuestions(questions: readonly DshQuestionItem[] | undefined): PaseoQuestion[];

export function questionPermission(input: {
  permissionId: string;
  eventId: string;
  questions: readonly DshQuestionItem[];
}): {
  id: string;
  name: string;
  kind: 'question';
  title: string;
  input: { questions: PaseoQuestion[] };
  metadata: { dshEventId: string };
};

export function toDshOutcome(
  mapped: readonly PaseoQuestion[],
  response: { behavior?: string; message?: string; updatedInput?: { answers?: Record<string, string> } } | null | undefined,
): DshQuestionOutcome;
