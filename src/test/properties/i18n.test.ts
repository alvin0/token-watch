import * as assert from "node:assert";
import * as vscode from "vscode";
import { isAppLanguage, localeTag, translate } from "../../shared/i18n.js";
import { LANGUAGE_STORAGE_KEY, LanguageController } from "../../host/LanguageController.js";

suite("Application localization", () => {
  test("supports English, Vietnamese, and Japanese with interpolation", () => {
    assert.strictEqual(isAppLanguage("en"), true);
    assert.strictEqual(isAppLanguage("vi"), true);
    assert.strictEqual(isAppLanguage("ja"), true);
    assert.strictEqual(isAppLanguage("fr"), false);
    assert.strictEqual(translate("en", "loading.scanning", { processed: 2, total: 5 }), "Scanning 2 of 5 files");
    assert.strictEqual(translate("vi", "common.confirm"), "Xác nhận");
    assert.strictEqual(translate("ja", "common.confirm"), "確認");
    assert.strictEqual(localeTag("vi"), "vi-VN");
    assert.strictEqual(localeTag("ja"), "ja-JP");
  });

  test("loads and persists the selected language in global state", async () => {
    const state = new MemoryMemento({ [LANGUAGE_STORAGE_KEY]: "vi" });
    const controller = new LanguageController(state as unknown as vscode.Memento);
    assert.strictEqual(controller.getLanguage(), "vi");

    await controller.setLanguage("ja");
    assert.strictEqual(controller.getLanguage(), "ja");
    assert.strictEqual(state.get(LANGUAGE_STORAGE_KEY), "ja");
    await assert.rejects(() => controller.setLanguage("fr"), /Unsupported language/);
  });

  test("emits the selected language after it changes", async () => {
    const controller = new LanguageController(new MemoryMemento() as unknown as vscode.Memento);
    const changes: string[] = [];
    controller.onDidChange((language) => changes.push(language));

    await controller.setLanguage("vi");
    assert.deepStrictEqual(changes, ["vi"]);
  });
});

class MemoryMemento {
  private readonly values = new Map<string, unknown>();

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.values.set(key, value);
    }
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return Array.from(this.values.keys());
  }
}
