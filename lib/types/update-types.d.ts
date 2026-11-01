export declare const UPDATE_PATH = "/api/qqbot/update";
export interface ReleaseUpdate {
    version: string;
    url: string;
    notes: string;
    page: string;
}
export interface UpdateView {
    current: string;
    checked?: number;
    release?: ReleaseUpdate;
    busy?: boolean;
    message?: string;
    restart?: boolean;
}
