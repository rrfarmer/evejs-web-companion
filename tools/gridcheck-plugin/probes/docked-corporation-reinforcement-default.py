from eve.client.script.ui.services.corporation.base_corporation import Corporation
from eve.client.script.ui.structure.deployment import deploymentContUtil as deployment
from eve.client.script.ui.structure.deployment.deploymentCont import ReinforcementTimeCont
from eve.client.script.ui.structure.structureBrowser.corpStructureSettingsCont import CorpStructureSettingsCont
from localization import GetByLabel
from types import FunctionType
from utillib import KeyVal

calls = []
notices = []
registry = KeyVal(SetStructureReinforceDefault=lambda hour: calls.append([hour]))
corporation = KeyVal(GetCorpRegistry=lambda: registry)
writeMethod = Corporation.SetStructureReinforceDefault.im_func
write = FunctionType(writeMethod.func_code, dict(writeMethod.func_globals,
                     prompt_player_fsd_dialog=lambda key, values: notices.append([key, values['notify']])))
corporation.SetStructureReinforceDefault = lambda hour: write(corporation, hour)
picker = KeyVal(hourCombo=KeyVal(GetValue=lambda: 21))
picker.GetReinforcementTime = lambda: ReinforcementTimeCont.GetReinforcementTime.im_func(picker)
applyMethod = CorpStructureSettingsCont._ApplyReinforceChanges.im_func
FunctionType(applyMethod.func_code, dict(applyMethod.func_globals, sm=KeyVal(GetService=lambda name: corporation)))(
    KeyVal(reinforcementTimeCont=picker))

result = dict(station=session.stationid, tab=GetByLabel('UI/StructureBrowser/CorpSettingsTab'),
              title=GetByLabel('UI/StructureBrowser/DefaultReinforcement'),
              hint=GetByLabel('UI/StructureBrowser/DefaultReinforcementHint'),
              label=GetByLabel(deployment.GetHourPickerLabelPath(None)),
              subtext=GetByLabel(deployment.GetPrimeHourSubtextLabelPath(None)),
              hourHint=GetByLabel(deployment.GetPrimeHourLabelPath(None)),
              apply=GetByLabel('UI/Commands/Apply'), chosen=picker.GetReinforcementTime(),
              calls=calls, notices=notices)
