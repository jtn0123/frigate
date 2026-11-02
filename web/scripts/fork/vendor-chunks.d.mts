export function packageName(id: string): string | undefined;
export const VENDOR_CHUNKS: [string, (id: string) => boolean][];
export function vendorChunkGroups(): {
  name: string;
  test: (id: string) => boolean;
  priority: number;
}[];
