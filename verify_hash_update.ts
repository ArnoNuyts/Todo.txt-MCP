import { Todo } from "./logic/todo.ts";

async function test() {
  const todo = new Todo("Test todo");
  const oldHash = await todo.getHash();
  console.log(`Initial: ${todo.toString()} [${oldHash}]`);

  todo.setText("Updated todo");
  const newHash = await todo.getHash();
  console.log(`Updated: ${todo.toString()} [${newHash}]`);

  if (oldHash === newHash) {
    console.error("FAIL: Hash did not change after setText");
  } else {
    console.log("PASS: Hash changed after setText");
  }

  const todo2 = new Todo("Task to mark done");
  const hash2 = await todo2.getHash();
  console.log(`\nInitial 2: ${todo2.toString()} [${hash2}]`);

  todo2.toggleState();
  const hash2Done = await todo2.getHash();
  console.log(`Done 2: ${todo2.toString()} [${hash2Done}]`);

  if (hash2 === hash2Done) {
    console.error("FAIL: Hash did not change after toggleState");
  } else {
    console.log("PASS: Hash changed after toggleState");
  }
}

test();
