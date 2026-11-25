# Read Structure Browser filter groups and service column settings from the live client.
import evetypes
from eve.client.script.ui.station.stationServiceConst import serviceData
from eve.client.script.ui.structure.structureBrowser.browserUIConst import STRUCTURES_BY_GROUPS
from eve.client.script.ui.structure.structureBrowser.extaColumnUtil import FormatColumnValue, GetHeaderForService, GetSettingDataObjectForServiceName
from eve.client.script.ui.structure.structureBrowser.filterContUtil import GetStructureTypeGroupName

groups = [[group_id, GetStructureTypeGroupName(group_id),
           [[label_id, evetypes.GetName(label_id), type_ids] for label_id, type_ids in choices]]
          for group_id, choices in STRUCTURES_BY_GROUPS.iteritems()]
columns = []
for service in serviceData:
    setting = GetSettingDataObjectForServiceName(service.name)
    if setting is not None:
        columns.append([service.serviceID, setting.settingID, GetHeaderForService(service.name),
                        FormatColumnValue(2.5, setting.valueType, setting.settingID)])
result = {'groups': sorted(groups), 'columns': sorted(columns)}
