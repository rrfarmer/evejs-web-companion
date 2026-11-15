// ShipTreeSvc's faction graph definitions in 24.02 (3698585).
// Each row is one child node. Offsets are in 350 px tree units and node zero is the capsule.
export type LayoutEdge = readonly [parent: number, dx: number, dy: number, groupID?: number, columns?: number];

export const EMPIRE_LAYOUT: readonly LayoutEdge[] = [
  [0, 1 / 2, 0, 4], // Rookie
  [1, 0, 3 / 4],
  [1, 3 / 4, 0],
  [3, 1 / 12, -1 / 12],
  [4, 0, -1 / 2, 8], // Frigate
  [5, 0, -1 / 2, 9, 4], // NavyFrigate
  [6, 0, -1 / 3],
  [7, 1 / 3, -1 / 3, 10, 6], // Interceptor
  [7, 0, -1 / 2],
  [9, 1 / 3, -1 / 3, 11, 6], // Assault
  [9, 0, -1 / 2],
  [11, 1 / 3, -1 / 3, 12, 6], // CovertOps
  [11, 0, -1 / 2],
  [13, 1 / 3, -1 / 3, 13, 6], // ElectronicAttack
  [13, 0, -1 / 2],
  [15, 1 / 3, -1 / 3, 94, 6], // LogisticsFrigates
  [5, 5 / 4, 0, 14], // Destroyer
  [17, 0, -1 / 2, 2101, 4], // NavyDestroyers
  [18, 0, -1 / 3],
  [19, 1 / 3, -1 / 3, 15], // Interdictor
  [19, 0, -1 / 2],
  [21, 1 / 3, -1 / 3, 93], // CommandDestroyers
  [21, 0, -1 / 2],
  [23, 1 / 3, -1 / 3, 50], // TacticalDestroyer
  [17, 5 / 4, 0, 16], // Cruiser
  [25, 0, -1 / 2, 17, 4], // NavyCruiser
  [26, 0, -1 / 3],
  [27, 1 / 3, -1 / 3, 18, 6], // Recon
  [27, 0, -1 / 2],
  [29, 1 / 3, -1 / 3, 19, 6], // HeavyAssault
  [29, 0, -1 / 2],
  [31, 1 / 3, -1 / 3, 20, 6], // HeavyInterdictor
  [31, 0, -1 / 2],
  [33, 1 / 3, -1 / 3, 21, 6], // Logistics
  [33, 0, -1 / 2],
  [35, 1 / 2, -1 / 2, 22, 6], // StrategicCruiser
  [25, 3 / 2, 0, 23], // Battlecruiser
  [37, 0, -1 / 2, 25], // NavyBattlecruiser
  [38, 0, -1 / 3],
  [39, 1 / 3, -1 / 3, 24], // Commandship
  [37, 3 / 2, 0, 26], // Battleship
  [41, 0, -1 / 2, 47], // NavyBattleship
  [42, 0, -3 / 8],
  [43, 1 / 3, -1 / 3, 27], // BlackOps
  [43, 0, -1 / 2],
  [45, 1 / 3, -1 / 3, 28], // Marauder
  [41, 7 / 4, 0],
  [47, 1 / 4, 0, 32], // Dreadnought
  [48, 0, -2 / 3, 2102, 4], // NavyDreadnoughts
  [49, 0, -1 / 2],
  [50, 1 / 3, -1 / 3, 2104, 4], // LancerDreadnought
  [47, 0, -2],
  [52, 1 / 3, -1 / 3, 33], // Carrier
  [52, 0, -5 / 6],
  [54, 1 / 3, -1 / 3, 2113], // CommandCarrier
  [54, 0, -5 / 6],
  [56, 1 / 3, -1 / 3, 34], // Titan
  [2, 1 / 12, 1 / 12],
  [58, 1 / 2, 0, 35], // Shuttle
  [59, 17 / 4, 0, 36], // Industrial
  [60, 0, -1 / 3],
  [61, 1 / 4, -1 / 4, 40], // Transport
  [60, 3, 0, 37], // Freighter
  [63, 0, -1 / 8],
  [64, 1 / 2, -1 / 2, 38], // JumpFreighter
];

export const ORE_LAYOUT: readonly LayoutEdge[] = [
  [0, 1 / 2, 0],
  [1, 0, 1],
  [1, 0, 1],
  [1, 1 / 2, 0, 41], // MiningFrigate
  [4, 0, -1 / 2, 2111, 4], // NavyMiningFrigate
  [5, 0, -1 / 4],
  [6, 1 / 4, -1 / 4, 48, 6], // ExpeditionFrigate
  [4, 5 / 4, 0, 2108], // MiningDestroyer
  [8, 0, -1 / 2, 2110], // NavyMiningDestroyer
  [9, 0, -1 / 4],
  [10, 1 / 4, -1 / 4, 2112], // MiningCommandDestroyer
  [8, 1, 0, 42], // MiningBarge
  [12, 0, -1 / 4],
  [13, 1 / 4, -1 / 4, 43], // Exhumers
  [3, 5 / 2, 0, 44], // OreIndustrial
  [15, 0, 1],
  [16, 2, 0, 37], // Freighter
  [15, 1, 0, 45], // IndustrialCommand
  [18, 1, 0, 46], // CapitalIndustrial
];

export const TRIGLAVIAN_LAYOUT: readonly LayoutEdge[] = [
  [0, 1 / 2, 0, 8], // Frigate
  [1, 0, -1 / 3],
  [2, 1 / 3, -1 / 3, 11, 6], // Assault
  [1, 5 / 4, 0, 14], // Destroyer
  [4, 0, -1 / 3],
  [5, 1 / 3, -1 / 3, 93], // CommandDestroyers
  [4, 5 / 4, 0, 16], // Cruiser
  [7, 0, -1 / 3],
  [8, 1 / 3, -1 / 3, 19], // HeavyAssault
  [7, 0, -1 / 2],
  [10, 0, -1 / 3],
  [11, 1 / 3, -1 / 3, 21], // Logistics
  [7, 5 / 4, 0, 23], // Battlecruiser
  [13, 5 / 4, 0, 26], // Battleship
  [14, 0, -1 / 3],
  [15, 1 / 3, -1 / 3, 28], // Marauder
  [14, 5 / 4, 0],
  [17, 1 / 4, 0, 32], // Dreadnought
];

export const EDENCOM_LAYOUT: readonly LayoutEdge[] = [
  [0, 1 / 2, 0],
  [1, 0, 0],
  [1, 0, 1],
  [2, 1 / 2, 0, 8], // Frigate
  [4, 5 / 4, 0, 16], // Cruiser
  [5, 5 / 4, 0, 26], // Battleship
  [3, 3 / 4, 0, 36], // Industrial
  [7, 0, -1 / 3],
  [8, 1 / 4, -1 / 4, 40], // Transport
  [7, 2, 0, 37], // Freighter
];

export const CONCORD_LAYOUT: readonly LayoutEdge[] = [
  [0, 1 / 2, 0, 35], // Shuttle
  [1, 1, 0, 12], // CovertOps
  [2, 5 / 4, 0, 18], // Recon
  [3, 0, -1 / 3],
  [4, 1 / 3, -1 / 3, 96], // FlagCruiser
  [3, 5 / 4, 0, 27], // BlackOps
];

export const SOCT_LAYOUT: readonly LayoutEdge[] = [
  [0, 1 / 2, 0, 35], // Shuttle
  [1, 1, 0, 8], // Frigate
  [2, 1, 0, 14], // Destroyer
  [3, 1, 0, 23], // Battlecruiser
  [4, 1, 0, 26], // Battleship
];
