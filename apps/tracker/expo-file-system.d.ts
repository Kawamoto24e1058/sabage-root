declare module 'expo-file-system' {
  export const documentDirectory: string | null;
  export function writeAsStringAsync(fileUri: string, contents: string, options?: { encoding?: string }): Promise<void>;
  export function readAsStringAsync(fileUri: string, options?: { encoding?: string }): Promise<string>;
  export function deleteAsync(fileUri: string, options?: { idempotent?: boolean }): Promise<void>;
  export function getInfoAsync(fileUri: string): Promise<{ exists: boolean; isDirectory?: boolean; size?: number; uri?: string }>;
}
