# Read the native owned-directory headers, service filters, and upkeep states.
import structures
from localization import GetByLabel
from eve.client.script.ui.structure.structureBrowser.controllers.filterContController import FilterContControllerMyStructures
from eve.client.script.ui.structure.structureBrowser.entries.structureEntryMyCorp import StructureEntryMyCorp, StructureEntryMyCorpAllProfiles

filters = FilterContControllerMyStructures()
result = {
    'allProfiles': StructureEntryMyCorpAllProfiles.GetHeaders(-1),
    'oneProfile': StructureEntryMyCorp.GetHeaders(-1),
    'jumpBridge': StructureEntryMyCorp.GetHeaders(['jumpbridge']),
    'lowPowerDefault': filters.OnlyShowLowPower(),
    'allowedServices': [entry.serviceID for entry in filters._GetSortedServiceOption()],
    'upkeep': [structures.UPKEEP_STATE_FULL_POWER, structures.UPKEEP_STATE_LOW_POWER, structures.UPKEEP_STATE_ABANDONED],
    'states': [[state, GetByLabel(label)] for state, label in sorted(structures.STATE_LABELS.iteritems())],
}
