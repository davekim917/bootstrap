const ANSWER = {
  answers: {
    dispatch: {
      choice: 'workhorse-medium',
      confidence: 0.9,
      probabilities: { 'workhorse-medium': 0.9, ask: 0.1 },
    },
  },
};

globalThis.fetch = async (url, options) => {
  if (url !== 'https://api.typesafe.ai/v1/systemone') throw new Error('unexpected endpoint');
  if (options?.method !== 'POST' || options?.headers?.['Content-Type'] !== 'application/json') {
    throw new Error('unexpected request metadata');
  }
  const body = JSON.parse(options.body);
  if (body?.model !== 'jev-1.13.0' || body?.state?.task_brief !== 'synthetic helper wire task') {
    throw new Error('unexpected request body');
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(ANSWER) };
};
