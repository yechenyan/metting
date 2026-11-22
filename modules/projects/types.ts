import type { Meeting, Settings } from "../meetings/types.ts";
export interface Project {
  id: string;
  name: string;
  directoryName: string;
  pendingDirectoryName?: string;
  legacyFolders?: string[];
  folder: string;
  created: string;
  maxRecordingMinutes: number;
  defaults: Settings;
  meetings: Meeting[];
}
