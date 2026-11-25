export interface TrainingCharacter {
  readonly characterID: number;
  readonly name: string;
  readonly corporationID?: number | null;
  readonly corporationName?: string | null;
}
