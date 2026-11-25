export interface TrainingCorporation { corporationID: number; name: string; divisions: { accountKey: number; name: string }[] }
export interface TrainingSettingsContext {
  corporations: TrainingCorporation[];
  authorities: { characterID: number; name: string; corporationID: number; eligible: boolean }[];
}
