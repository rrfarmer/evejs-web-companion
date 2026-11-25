# Read the native My Structures scheduling label and refinery-only predicate.
import evetypes
import structures
from localization import GetByLabel
from eve.client.script.ui.structure.structureBrowser.entries.structureEntryMyCorp import StructureEntryMyCorp

can_schedule = StructureEntryMyCorp.IsSchedulingAvailableOption.im_func
result = {'label': GetByLabel('UI/Moonmining/OpenSchedulingWnd'),
          'astra': can_schedule(None, 35832, 1030000000000L),
          'athanorGroup': evetypes.GetGroupID(35835),
          'tataraGroup': evetypes.GetGroupID(35836),
          'moonService': structures.SERVICE_MOONMINING}
