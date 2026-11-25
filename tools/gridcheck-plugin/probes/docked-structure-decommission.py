# Read decommission policy and labels without scheduling an unanchor.
from localization import GetByLabel
import structures
from structures.types import GetUnanchoringDuration

result = {
    'start': GetByLabel('UI/StructureBrowser/Decommission'),
    'cancel': GetByLabel('UI/StructureBrowser/CancelDecommission'),
    'blockedStates': sorted(state for state, blocked in structures.STATE_CANCELS_UNANCHOR.iteritems() if blocked),
    'durations': [[type_id, GetUnanchoringDuration(type_id)] for type_id in (35832, 35841, 81826)],
    'directorMask': int(const.corpRoleDirector),
}
