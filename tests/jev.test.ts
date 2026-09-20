import { expect, it } from "vitest";
import { TypeSafeEvaluationModel } from "../src/chooser/jev.js";

it("sends well-formed Unicode for nested page state and question text", async () => {
  let sent: unknown;
  const model = new TypeSafeEvaluationModel({
    apiKey: "test-key",
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ answers: {}, usage: { input_tokens: 1 } });
    },
  });
  await model.doEvaluate({
    state: { controls: [{ name: "Search 🐍", snippet: "Python \ud83d" }] },
    questions: {
      target: {
        type: "choice",
        instructions: "Find \udc00 jobs",
        criteria: { option_0: { text: "Engineer \ud83d", href: "https://example.test/jobs" } },
      },
    },
  });
  expect(sent).toEqual({
    model: "jev-latest",
    state: { controls: [{ name: "Search 🐍", snippet: "Python �" }] },
    questions: {
      target: {
        type: "choice",
        instructions: "Find � jobs",
        criteria: { option_0: { text: "Engineer �", href: "https://example.test/jobs" } },
      },
    },
  });
});
