# Read the native reinforcement editor without submitting a change.
from localization import GetByLabel
from eve.client.script.ui.structure.structureBrowser.reinforcementTimeWnd import ReinforcementTimeWnd
from eve.client.script.ui.structure.structureBrowser.controllers.reinforceTimersBundle import ReinforcementBundle

window = ReinforcementTimeWnd.Open(infoOnStructures=[(1030000000000L, 30000144, 35832)],
                                  reinforceTimers=ReinforcementBundle(reinforceWeekday=255, reinforceHour=18),
                                  changedStructures=[], doAllStructuresHavePendingChanges=False)
try:
    result = {
        'title': GetByLabel('UI/StructureBrowser/SetReinforcementTime'),
        'delay': GetByLabel('UI/StructureBrowser/ReinforcementTimeChangeDelay'),
        'picker': window.reinforceTimeCont.hourPickerLabel.text,
        'value': list(window.reinforceTimeCont.GetReinforcementTime()),
        'button': GetByLabel('UI/Commands/Apply'),
    }
finally:
    window.Close()
