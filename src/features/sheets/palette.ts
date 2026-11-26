/**
 * Sheet colours are stored as hex (Excel-compatible) and adapted for dark themes by the renderer. The swatches use
 * the block palette (§3.4) so sheets match the rest of the app.
 */
import type { BlockColor } from '@/backend/types';

export interface Swatch {
  name: string;
  hex: string;
}

export const TEXT_SWATCHES: Swatch[] = [
  { name: 'Default', hex: '' },
  { name: 'Gray', hex: '#6F6E69' },
  { name: 'Brown', hex: '#8A5A3F' },
  { name: 'Orange', hex: '#B85A00' },
  { name: 'Yellow', hex: '#9A6700' },
  { name: 'Green', hex: '#2F7A4F' },
  { name: 'Blue', hex: '#1F6FA8' },
  { name: 'Purple', hex: '#7E4FA8' },
  { name: 'Pink', hex: '#B03A78' },
  { name: 'Red', hex: '#C23B36' },
];

export const FILL_SWATCHES: Swatch[] = [
  { name: 'None', hex: '' },
  { name: 'Gray', hex: '#F1F1F0' },
  { name: 'Brown', hex: '#F5EEEA' },
  { name: 'Orange', hex: '#FCEBDC' },
  { name: 'Yellow', hex: '#FBF3D9' },
  { name: 'Green', hex: '#EAF4EC' },
  { name: 'Blue', hex: '#E6F1F9' },
  { name: 'Purple', hex: '#F3EEF9' },
  { name: 'Pink', hex: '#FBEEF4' },
  { name: 'Red', hex: '#FDECEC' },
];

export const STRONG_FILL_SWATCHES: Swatch[] = [
  { name: 'Graphite', hex: '#D4D4D8' },
  { name: 'Sand', hex: '#E8D9CC' },
  { name: 'Apricot', hex: '#F9D2B0' },
  { name: 'Butter', hex: '#F6E3A1' },
  { name: 'Mint', hex: '#C6E8D1' },
  { name: 'Sky', hex: '#BFDDF3' },
  { name: 'Lavender', hex: '#DCD1F1' },
  { name: 'Rose', hex: '#F4CFE0' },
  { name: 'Coral', hex: '#F7C8C6' },
];

export const TAB_COLORS: BlockColor[] = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];

export const SCALE_PRESETS: { name: string; colors: string[] }[] = [
  { name: 'Red → yellow → green', colors: ['#F8B4B4', '#FBE7A1', '#A7DDB9'] },
  { name: 'Green → yellow → red', colors: ['#A7DDB9', '#FBE7A1', '#F8B4B4'] },
  { name: 'White → green', colors: ['#FFFFFF', '#7CCB98'] },
  { name: 'White → blue', colors: ['#FFFFFF', '#8EC1EA'] },
  { name: 'White → iris', colors: ['#FFFFFF', '#AFAEF4'] },
  { name: 'Blue → white → red', colors: ['#8EC1EA', '#FFFFFF', '#F3A5A5'] },
];

export const BAR_PRESETS: { name: string; color: string }[] = [
  { name: 'Iris', color: '#7D7BF5' },
  { name: 'Sky', color: '#38BDF8' },
  { name: 'Teal', color: '#14B8A6' },
  { name: 'Amber', color: '#F59E0B' },
  { name: 'Pink', color: '#EC4899' },
  { name: 'Lime', color: '#65A30D' },
];

export const HIGHLIGHT_PRESETS: { name: string; fill: string; text: string }[] = [
  { name: 'Red', fill: '#FDE2E1', text: '#C9302C' },
  { name: 'Amber', fill: '#FCEFD0', text: '#A15C00' },
  { name: 'Green', fill: '#DCF2E3', text: '#0B7F45' },
  { name: 'Blue', fill: '#DDEBF8', text: '#1F6FA8' },
  { name: 'Iris', fill: '#E8E7FC', text: '#4B49C8' },
  { name: 'Bold only', fill: '', text: '' },
];

export function gradientCss(colors: string[]): string {
  return `linear-gradient(90deg, ${colors.join(', ')})`;
}
