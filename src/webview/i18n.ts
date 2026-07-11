import { useStore } from "./store";
import { localeTag, translate, type TranslationKey } from "../shared/i18n";

export function useTranslation() {
  const language = useStore((state) => state.language);
  return {
    language,
    locale: localeTag(language),
    t: (key: TranslationKey, values?: Record<string, string | number>) => translate(language, key, values),
  };
}
