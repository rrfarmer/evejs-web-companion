from carbonui.uicore import uicore
from eve.client.script.ui.shared.neocom.neocom import neocomConst
from localization import GetByLabel
from neocom2 import btnIDs
from projectdiscovery.client.windowclass import get_project_discovery_window_class

def measure():
    neocom = sm.GetService('neocom')
    rail = [node.id for node in neocom.mainBtnDataRoot.children]
    defaults = [row[1] for row in neocomConst.RAWDATA_NEOCOMDEFAULT]
    activities = [row[1] for row in neocomConst.RAWDATA_EVEMENU_GROUP_ACTIVITIES[2]]
    discovery = sm.GetService('projectDiscoveryClient')
    window_class = get_project_discovery_window_class()
    command = uicore.cmd.ToggleProjectDiscovery
    data = {
        'station': session.stationid,
        'id': btnIDs.PROJECT_DISCOVERY_ID,
        'rail': rail, 'defaults': defaults, 'activities': activities,
        'enabled': bool(discovery.is_enabled()),
        'windowID': window_class.default_windowID,
        'caption': window_class.default_caption,
        'defaultSize': [window_class.default_width, window_class.default_height],
        'minimum': list(window_class.default_minSize),
        'tooltip': GetByLabel(command.descriptionLabelPath),
        'icon': window_class.default_iconNum
    }
    return data

result = measure()
