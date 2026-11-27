import { formatTemplate, plainText } from "./clientWords.ts";
import { labelEscaped } from "./labelMarkup.ts";

export const hyperNetLinkLabel = "UI/HyperNet/Link";

export function parseHyperNetOfferUrl(url: string): number | null {
  const id = Number(/^hypernet:([1-9]\d*)$/i.exec(url)?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function hyperNetOfferUrl(id: number): string {
  return `hyperNet:${id}`;
}

export function hyperNetOfferLinkText(name: string, template?: string): string {
  return plainText(formatTemplate(template ?? "HyperNet Offer: {item_name}",
    { item_name: labelEscaped(name) }, { nameOf: () => "" }));
}
