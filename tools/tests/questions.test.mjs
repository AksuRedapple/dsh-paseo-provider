import test from 'node:test';
import assert from 'node:assert/strict';
import { mapQuestions, questionPermission, toDshOutcome } from '../../server/questions.mjs';

const DSH_QUESTIONS = [
  {
    id: 'scope',
    question: '改哪一层？',
    header: 'Choose Mode',
    options: [
      { label: '只改 provider（Recommended）', description: '最小改动' },
      { label: '连 gateway 一起改' },
    ],
  },
  { id: 'tags', question: '要哪些？', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true },
  { id: 'note', question: '补充说明' },
];

test('mapQuestions: header 兜底/去重，选项与多选透传', () => {
  const mapped = mapQuestions(DSH_QUESTIONS);
  assert.equal(mapped.length, 3);
  assert.equal(mapped[0].header, 'Choose Mode');
  // 第 2 题没 header → Q2；第 3 题没 header → Q3（保持唯一）
  assert.equal(mapped[1].header, 'Q2');
  assert.equal(mapped[2].header, 'Q3');
  assert.deepEqual(mapped[0].options.map((o) => o.label), ['只改 provider（Recommended）', '连 gateway 一起改']);
  assert.equal(mapped[0].options[0].description, '最小改动');
  assert.equal(mapped[0].multiSelect, false);
  assert.equal(mapped[1].multiSelect, true);
  // 有选项 → 允许「其他」；无选项 → 整题自由作答
  assert.equal(mapped[0].allowOther, true);
  assert.equal(mapped[2].options.length, 0);
  assert.equal(mapped[2].allowOther, true);
  assert.equal(mapped[2].allowEmpty, true);
});

test('mapQuestions: header 冲突时加后缀，绝不重复', () => {
  const mapped = mapQuestions([
    { id: 'a', question: 'A', header: 'Same' },
    { id: 'b', question: 'B', header: 'Same' },
    { id: 'c', question: 'C', header: 'Same' },
  ]);
  assert.deepEqual(mapped.map((q) => q.header), ['Same', 'Same (2)', 'Same (3)']);
});

test('mapQuestions: detail 并入题干，缺 id/question 也有兜底', () => {
  const mapped = mapQuestions([{ detail: '细节', header: 'H' }]);
  assert.equal(mapped[0].id, 'q1');
  assert.match(mapped[0].question, /问题 1\n\n细节/);
});

test('questionPermission: 生成 Paseo 的 kind=question 卡片', () => {
  const req = questionPermission({ permissionId: 'call-1', eventId: 'ev-1', questions: DSH_QUESTIONS });
  assert.equal(req.id, 'call-1');
  assert.equal(req.name, 'ask_user_question');
  assert.equal(req.kind, 'question');
  assert.equal(req.input.questions.length, 3);
  assert.deepEqual(req.metadata, { dshEventId: 'ev-1' });
});

test('toDshOutcome: 单选命中选项 / 未命中当自由文本', () => {
  const mapped = mapQuestions(DSH_QUESTIONS);
  const ok = toDshOutcome(mapped, { behavior: 'allow', updatedInput: { answers: { 'Choose Mode': '连 gateway 一起改' } } });
  assert.equal(ok.kind, 'result');
  assert.deepEqual(ok.value.answers[0], { id: 'scope', selected: ['连 gateway 一起改'] });
  // 没答的题 → selected 空数组（跳过）
  assert.deepEqual(ok.value.answers[1], { id: 'tags', selected: [] });

  const custom = toDshOutcome(mapped, { behavior: 'allow', updatedInput: { answers: { 'Choose Mode': '都别改，先讨论' } } });
  assert.deepEqual(custom.value.answers[0], { id: 'scope', selected: [], custom: '都别改，先讨论' });
});

test('toDshOutcome: 多选按 ", " 拆回标签，混入自由文本进 custom', () => {
  const mapped = mapQuestions(DSH_QUESTIONS);
  const out = toDshOutcome(mapped, {
    behavior: 'allow',
    updatedInput: { answers: { Q2: 'a, c, 我自己加的' } },
  });
  assert.deepEqual(out.value.answers[1], { id: 'tags', selected: ['a', 'c'], custom: '我自己加的' });
});

test('toDshOutcome: 自由作答题（无选项）整串进 custom', () => {
  const mapped = mapQuestions(DSH_QUESTIONS);
  const out = toDshOutcome(mapped, { behavior: 'allow', updatedInput: { answers: { Q3: '顺便把文档补上' } } });
  assert.deepEqual(out.value.answers[2], { id: 'note', selected: [], custom: '顺便把文档补上' });
});

test('toDshOutcome: 弹掉 → rejected + ASK_CANCELLED（DSH 会记成工具失败）', () => {
  const mapped = mapQuestions(DSH_QUESTIONS);
  assert.deepEqual(toDshOutcome(mapped, { behavior: 'deny' }), {
    kind: 'rejected',
    error: { name: 'UserQuestionError', message: 'the user dismissed ask_user_question', code: 'ASK_CANCELLED' },
  });
  assert.equal(toDshOutcome(mapped, { behavior: 'deny', message: '不想答' }).error.message, '不想答');
  assert.equal(toDshOutcome(mapped, null).kind, 'rejected');
});

test('toDshOutcome: updatedInput 缺失/脏数据不炸', () => {
  const mapped = mapQuestions(DSH_QUESTIONS);
  assert.deepEqual(toDshOutcome(mapped, { behavior: 'allow' }).value.answers.map((a) => a.selected),
    [[], [], []]);
  assert.deepEqual(toDshOutcome(mapped, { behavior: 'allow', updatedInput: { answers: [] } }).value.answers[0].selected, []);
});
