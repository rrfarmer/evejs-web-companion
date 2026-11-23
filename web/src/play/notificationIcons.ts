// notificationEntry.NOTIFICATION_TYPE_TO_TEXTURE, read from the live 3698585 client (gridcheck g272): each notification
// type's icon in the notification feed. A value is notificationIcon_<value>.png, or after "=" a path of its own.
// A type not here has no icon (GetTexturePathForNotification: None).

const ICONS: Readonly<Record<number, string>> = {
  2:"2", 4:"4", 5:"5", 6:"6", 7:"7", 8:"8",
  9:"9", 10:"10", 11:"11", 12:"9", 13:"10", 14:"14",
  15:"15", 16:"16", 19:"19", 21:"21", 22:"22", 23:"23",
  25:"25", 26:"26", 27:"27", 28:"5", 29:"29", 30:"30",
  31:"31", 32:"32", 33:"33", 34:"34", 35:"35", 36:"36",
  37:"37", 38:"38", 39:"39", 40:"40", 41:"41", 42:"42",
  43:"43", 44:"44", 45:"45", 46:"46", 47:"47", 48:"48",
  49:"49", 50:"50", 51:"51", 52:"52", 53:"53", 54:"54",
  55:"55", 56:"56", 57:"57", 58:"58", 59:"59", 60:"60",
  61:"61", 62:"62", 63:"63", 64:"64", 65:"65", 66:"66",
  67:"67", 68:"68", 69:"69", 70:"70", 71:"71", 72:"72",
  73:"73", 75:"75", 76:"76", 77:"77", 78:"78", 79:"79",
  80:"80", 81:"81", 82:"82", 83:"83", 84:"84", 85:"85",
  86:"86", 87:"87", 88:"88", 89:"89", 90:"90", 91:"91",
  92:"92", 93:"93", 94:"94", 95:"95", 96:"96", 97:"97",
  98:"98", 99:"99", 100:"100", 101:"101", 102:"102", 103:"103",
  104:"104", 105:"105", 106:"106", 107:"107", 108:"108", 109:"109",
  110:"110", 111:"111", 112:"112", 113:"113", 114:"114", 115:"115",
  116:"116", 117:"117", 118:"118", 119:"119", 120:"120", 121:"121",
  122:"122", 123:"123", 124:"124", 125:"125", 126:"109", 127:"127",
  132:"132", 133:"133", 136:"136", 137:"137", 138:"138", 170:"170",
  171:"171", 172:"172", 173:"173", 179:"179", 180:"180", 181:"StructureFuelAlert",
  182:"StructureAnchoring", 183:"StructureUnanchoring", 184:"StructureUnderAttack", 185:"StructureOnline", 186:"StructureLostShields", 187:"StructureLostArmor",
  188:"StructureDestroyed", 190:"StructureItemsToAssetSafety", 191:"StructureItemsNeedAttention", 192:"StructureMarketOrdersCancelled", 195:"StructureLostDockingAccess", 196:"StructureOfficeRentalBill",
  198:"StructureServicesOffline", 199:"StructureItemsDelivered", 200:"=res:/UI/Texture/classes/Seasons/eventIcon_64x64.png", 201:"moonDrill", 202:"moonDrill", 203:"moonDrill",
  204:"moonDrill", 205:"moonDrill", 206:"moonDrill", 207:"StructureFuelAlert", 208:"StructureFuelAlert", 209:"StructureReinforcementChanged",
  210:"StructureReinforcementChanged", 211:"StructureReinforcementChanged", 221:"BecameWarEligible", 222:"NoLongerWarEligible", 223:"30", 224:"27",
  225:"5", 226:"=res:/ui/Texture/WindowIcons/triglavianRace.png", 227:"=res:/ui/Texture/WindowIcons/triglavianRace.png", 228:"91", 229:"5", 230:"5",
  231:"5", 232:"121", 233:"5", 234:"5", 235:"5", 236:"5",
  237:"5", 238:"5", 239:"5", 240:"5", 241:"109", 242:"109",
  243:"=res:/UI/Texture/WindowIcons/hypernet.png", 244:"=res:/UI/Texture/WindowIcons/hypernet.png", 245:"=res:/UI/Texture/WindowIcons/hypernet.png", 246:"5", 247:"71", 248:"71",
  249:"StructureImpendingAbandonmentAssetsAtRisk", 250:"StructureOfficeLeaseExpiration", 251:"1006", 253:"=res:/UI/Texture/classes/ExpertSystems/badge_64.png", 254:"=res:/UI/Texture/WindowIcons/paint_tool.png", 260:"GoalCreated",
  261:"GoalClosed", 262:"GoalCompleted", 264:"GoalExpired", 265:"GoalCompleted", 275:"DailyGoalCompleted", 276:"DailyGoalCompleted",
  280:"=res:/UI/Texture/WindowIcons/paint_tool.png", 281:"skyhook", 282:"skyhook", 283:"skyhook", 284:"skyhook", 285:"skyhook",
  286:"mercenaryDen", 287:"mercenaryDen", 288:"mercenaryDen", 289:"63", 290:"GoalClosed", 292:"GoalCompleted",
  293:"GoalCompleted", 294:"GoalClosed", 295:"GoalCreated", 296:"GoalExpired", 297:"=res:/UI/Texture/WindowIcons/accessGroups.png", 1000:"1000",
  1001:"1001", 1002:"1002", 1003:"1003", 1005:"1005", 1006:"1006", 1007:"1006",
  1008:"1006", 1015:"=res:/UI/Texture/WindowIcons/ess.png", 1016:"=res:/UI/Texture/WindowIcons/ess.png", 1017:"=res:/UI/Texture/WindowIcons/ess.png", 1018:"=res:/UI/Texture/WindowIcons/ess.png", 1021:"1031",
  1022:"174", 1030:"1032", 1031:"1032", 1032:"1032", 1033:"1000", 1050:"=res:/ui/Texture/WindowIcons/calendar.png",
  1060:"1060", 1100:"=res:/ui/Texture/WindowIcons/augmentations.png", 1101:"=res:/ui/Texture/WindowIcons/augmentations.png", 1110:"insurgencies", 1111:"insurgencies", 1112:"insurgencies",
  1113:"insurgencies", 1114:"insurgencies", 1115:"insurgencies", 1116:"insurgencies", 1234:"=res:/UI/Texture/icons/50_64_11.png", 2001:"2001",
  2002:"2002", 4001:"newOfferIcon", 4002:"newOfferIcon", 5001:"180", 6001:"=res:/UI/Texture/Icons/notifications/notification_CorpLicenseAcquired.png", 6002:"=res:/UI/Texture/Icons/notifications/notification_AllianceLicenseAcquired.png",
  6010:"DailyGoalCompleted", 6011:"DailyGoalCompleted", 6012:"DailyGoalCompleted", 6013:"DailyGoalCompleted", 6020:"=res:/UI/Texture/classes/Fitting/tabFittings.png", 6030:"skyhookReagent",
  6031:"skyhook", 6032:"VanguardNemesis", 6040:"StructureFuelAlert", 6041:"StructureFuelAlert",
};

const PREFIX = "res:/UI/Texture/Icons/notifications/notificationIcon_";

/** The res: path of a notification type's feed icon, or null. */
export function notificationIconPath(typeID: number): string | null {
  const v = ICONS[typeID];
  if (v === undefined) return null;
  return v.startsWith("=") ? v.slice(1) : `${PREFIX}${v}.png`;
}
