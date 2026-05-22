export const Principal = {
  USER: "USER",
  DISPLAY: "DISPLAY",
  WORKER: "WORKER",
  UNKNOWN: "UNKNOWN",
} as const;

export type PrincipalType = (typeof Principal)[keyof typeof Principal];

interface BaseIAMContext {
  principal: PrincipalType;
  validToken: boolean;
  id?: string;
  email?: string;
  workspaceId?: string;
  displayId?: string;
  siteId?: string;
  workspace?: {
    id: string;
    name: string;
    slug: string;
  };
}

export interface IAMContext extends BaseIAMContext {
  user?: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    status: string;
  };
  display?: {
    id: string;
    name: string | null;
    status: string;
    siteId: string;
    dashboardId: string | null;
    workcenterId: string | null;
    stationId: string | null;
  };
}

export interface UnknownIAMContext extends IAMContext {
  principal: typeof Principal.UNKNOWN;
  validToken: false;
}

export interface UserIAMContext extends IAMContext {
  principal: typeof Principal.USER;
  validToken: true;
  id: string;
  email: string;
  workspaceId?: string;
  siteId?: string;
}

export interface DisplayIAMContext extends IAMContext {
  principal: typeof Principal.DISPLAY;
  validToken: true;
  displayId: string;
  siteId: string;
  workspaceId: string;
}
