const tests = [];
const describeStack = [];

export function describe(name, fn) {
  describeStack.push(name);
  try {
    fn();
  } finally {
    describeStack.pop();
  }
}

export function it(name, fn) {
  const fullName = [...describeStack, name].join(" > ");
  tests.push({ name: fullName, fn });
}

export function getTests() {
  return tests;
}

