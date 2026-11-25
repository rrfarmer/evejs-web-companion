# Read the native Skyhooks tab labels, columns, filters and owned-list response.
from localization import GetByLabel
from eve.client.script.ui.structure.structureBrowser.entries.skyhookEntry import SkyhookEntry
from eve.client.script.ui.structure.structureBrowser.controllers.filterContController import FilterContControllerSkyhook
from orbitalSkyhook.const import STATE_LABELS, STATE_VULNERABILITY
from eve.common.lib import appConst
from eve.common.script.sys import idCheckers

filters = FilterContControllerSkyhook()
rows = sm.GetService('sovereigntyResourceSvc').GetMyCorporationSkyhooks()
result = {'label': GetByLabel('UI/StructureBrowser/MySkyhooks'),
          'headers': SkyhookEntry.GetHeaders(), 'npc': idCheckers.IsNPCCorporation(session.corpid),
          'stationManager': bool(session.corprole & appConst.corpRoleStationManager),
          'count': len(rows), 'states': [(k, GetByLabel(v), bool(STATE_VULNERABILITY.get(k, False))) for k, v in sorted(STATE_LABELS.items())]}
