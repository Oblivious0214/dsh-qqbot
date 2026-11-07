import { type PresetDraft } from './preset-validation.ts';
import { type RoleDraft } from './role-validation.ts';
import type { RoleDynamicsConfig } from './role-dynamics/types.ts';
import type { LibraryRole, LibraryView } from './library-types.ts';
export interface PackageRole extends Omit<RoleDraft, 'id' | 'dynamics' | 'dynamicsBaseRevision' | 'dynamicsRenames' | 'resetDynamics' | 'voice' | 'memePacks'> {
    readonly dynamics?: RoleDynamicsConfig;
}
export interface ConfigPackage {
    readonly format: 'dsh-qqbot-config';
    readonly version: 1 | 2;
    readonly presets: readonly PresetDraft[];
    readonly roles: readonly PackageRole[];
}
export declare function parseConfigurationPackage(value: unknown): ConfigPackage;
export declare function serializeRoleConfiguration(role: Pick<LibraryRole, 'name' | 'description' | 'persona'> & Partial<LibraryRole>): PackageRole;
export declare function serializeConfigurationPackage(view: Pick<LibraryView, 'roles' | 'presets'> & Partial<Pick<LibraryView, 'currentPreset'>>, kind?: 'roles' | 'presets' | 'all'): ConfigPackage;
