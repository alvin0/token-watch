import * as assert from "node:assert";
import {
  COORDINATOR_DISPOSED_MESSAGE,
  isCoordinatorDisposedError,
} from "../../host/IngestionCoordinator.js";

suite("Coordinator lifecycle", () => {
  test("recognizes only the expected shutdown rejection", () => {
    assert.strictEqual(
      isCoordinatorDisposedError(new Error(COORDINATOR_DISPOSED_MESSAGE)),
      true,
    );
    assert.strictEqual(isCoordinatorDisposedError(new Error("Worker exited")), false);
    assert.strictEqual(isCoordinatorDisposedError("Coordinator disposed"), false);
  });
});
