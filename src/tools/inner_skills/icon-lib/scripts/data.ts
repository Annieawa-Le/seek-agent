import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface IconEntry {
  codepoint: number;
  primaryName: string;
  aliases: string[];
  allNames: string[];
}

export interface DetailedIconEntry extends IconEntry {
  unicodeChar: string;
  unicodeHex: string;
  cssClass: string;
  svgUrl: string;
  localSvgPath: string;
  codiconCdnUrl: string;
}

let cachedData: Record<string, string[]> | null = null;

export function loadMappingData(): Record<string, string[]> {
  if (cachedData) return cachedData;

  // The mapping data is baked into the export
  // We load from references/mapping.json at runtime
  // This is a sync-like access; we'll cache it
  throw new Error('Use loadMappingDataAsync() instead');
}

export async function loadMappingDataAsync(): Promise<Record<string, string[]>> {
  if (cachedData) return cachedData;
  const mappingPath = path.join(__dirname, 'references', 'mapping.json');
  const raw = await fs.readFile(mappingPath, 'utf-8');
  cachedData = JSON.parse(raw);
  return cachedData!;
}

export function parseIcons(mapping: Record<string, string[]>): IconEntry[] {
  return Object.entries(mapping).map(([cp, names]) => ({
    codepoint: parseInt(cp, 10),
    primaryName: names[0],
    aliases: names.slice(1),
    allNames: names,
  }));
}

export function getDetailedEntry(icon: IconEntry): DetailedIconEntry {
  const hex = icon.codepoint.toString(16).padStart(4, '0');
  return {
    ...icon,
    unicodeChar: String.fromCodePoint(icon.codepoint),
    unicodeHex: `U+${hex.toUpperCase()}`,
    cssClass: `codicon codicon-${icon.primaryName}`,
    svgUrl: `https://raw.githubusercontent.com/microsoft/vscode-codicons/main/src/icons/${icon.primaryName}.svg`,
    localSvgPath: path.join(__dirname, 'references', 'icons', `${icon.primaryName}.svg`),
    codiconCdnUrl: `https://microsoft.github.io/vscode-codicons/dist/codicon.html#${icon.primaryName}`,
  };
}

