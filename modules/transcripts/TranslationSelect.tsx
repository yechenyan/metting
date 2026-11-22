import { t } from "../../apps/web/lib";
import { translationLanguages, type TranslationTarget } from "./translation";

const names = new Intl.DisplayNames(["zh-CN"], { type: "language" });
export function targetName(lang: NonNullable<TranslationTarget>) {
  return lang in t.targetNames
    ? t.targetNames[lang as keyof typeof t.targetNames]
    : (names.of(lang === "ns" ? "nso" : lang) ?? lang);
}
const options = translationLanguages.map((lang) => (
  <option key={lang} value={lang}>
    {targetName(lang)}
  </option>
));

export function TranslationSelect({
  value,
  label,
  change,
}: {
  value: TranslationTarget;
  label: string;
  change: (target: TranslationTarget) => void;
}) {
  return (
    <select
      className="translation-target"
      aria-label={label}
      title={label}
      value={value ?? ""}
      onChange={(e) => change((e.target.value || null) as TranslationTarget)}
    >
      <option value="">{t.translationOff}</option>
      {options}
    </select>
  );
}
