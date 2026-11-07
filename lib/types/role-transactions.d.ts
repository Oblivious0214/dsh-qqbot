import { type TransactionFault } from './data-transactions.ts';
import type { RoleDynamicsService } from './role-dynamics/service.ts';
import type { Maintenance } from './maintenance.ts';
import type { PreparedRoleSave, Role, RoleLibrary, RoleTransactions } from './roles.ts';
export declare const progressDirectory: (root: string, id: string) => string;
export declare class RoleDataTransactions implements RoleTransactions {
    private readonly roles;
    private readonly options;
    private readonly root;
    private active;
    private unregister;
    constructor(roles: RoleLibrary, options?: {
        dynamics?: RoleDynamicsService;
        maintenance?: Maintenance;
        prepareHistory?(roleId: string): Promise<void>;
        invalidated?(): void;
        fault?: TransactionFault;
    });
    dispose(): void;
    private run;
    save(prepared: PreparedRoleSave): Promise<Role>;
    remove(id: string, extras: readonly string[]): Promise<string>;
    restore(stamp: string): Promise<void>;
}
