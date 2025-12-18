import { Todo } from "./logic/todo.ts";

const todoWithDate = new Todo("2023-10-27 Test todo");
console.log("Original toString (should have date):");
console.log(todoWithDate.toString());

console.log("\nNew toDisplayString (should NOT have date):");
console.log(todoWithDate.toDisplayString());

if (todoWithDate.toString().includes("2023-10-27")) {
  console.log("\n[PASS] toString includes date");
} else {
  console.error("\n[FAIL] toString missing date");
}

if (!todoWithDate.toDisplayString().includes("2023-10-27")) {
  console.log("[PASS] toDisplayString excludes date");
} else {
  console.error("[FAIL] toDisplayString includes date");
}
