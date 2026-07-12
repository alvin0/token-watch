import * as vscode from "vscode";
import { isAppLanguage, type AppLanguage } from "../shared/i18n";

export const LANGUAGE_STORAGE_KEY = "tokenWatch.language.v1";

export class LanguageController {
  private language: AppLanguage;
  private readonly languageChanged = new vscode.EventEmitter<AppLanguage>();
  readonly onDidChange = this.languageChanged.event;

  constructor(private readonly globalState: vscode.Memento) {
    const stored = globalState.get<unknown>(LANGUAGE_STORAGE_KEY);
    this.language = isAppLanguage(stored) ? stored : languageFromVsCode(vscode.env.language);
  }

  getLanguage(): AppLanguage {
    return this.language;
  }

  async setLanguage(value: unknown): Promise<AppLanguage> {
    if (!isAppLanguage(value)) {
      throw new Error("Unsupported language.");
    }
    await this.globalState.update(LANGUAGE_STORAGE_KEY, value);
    this.language = value;
    this.languageChanged.fire(value);
    return value;
  }
}

function languageFromVsCode(value: string): AppLanguage {
  const language = value.toLowerCase();
  if (language.startsWith("vi")) { return "vi"; }
  if (language.startsWith("ja")) { return "ja"; }
  return "en";
}
