from eve.client.script.ui.structure.structureSettings.controllers.settingController import SettingController
from eve.client.script.ui.structure.structureSettings.structureSettingsWnd import StructureProfileSettingCont
from localization import GetByLabel
from types import FunctionType
from utillib import KeyVal
import structures

calls = []
groupLookup = KeyVal(PopulatePublicGroupInfo=lambda ids, **kw: None, GetGroupInfoFromID=lambda *a, **kw: True)
controller = KeyVal(GetAllGroups=lambda: {19: [SettingController(19, 5001)], 4: [SettingController(4, 5001, 7.5)]},
                    SaveProfile=lambda rows: calls.extend(rows))
browser = KeyVal(HasProfileChanged=lambda: True, SetProfileChangedValue=lambda changed: None)
panel = KeyVal(structureProfileController=controller, structureBrowserController=browser)
method = StructureProfileSettingCont.SaveProfile.im_func
context = dict(method.func_globals, sm=KeyVal(GetService=lambda name: KeyVal(GetAccessGroupController=lambda: groupLookup)))
FunctionType(method.func_code, context)(panel)

categories = list(structures.CATEGORIES_HULL) + sorted(structures.CATEGORIES_MODULES, key=structures.CATEGORY_LABELS.get)
result = dict(station=session.stationid, title=GetByLabel('UI/StructureBrowser/ProfileSettings'),
              categories=[(key, GetByLabel(structures.CATEGORY_LABELS[key]), list(structures.SETTINGS_BY_CATEGORY[key])) for key in categories],
              settings=[(row.settingID, GetByLabel(row.labelPath), row.valueType, row.valueRange, row.decimals)
                        for row in structures.ALL_SETTING_OBJECTS],
              calls=sorted(calls))
