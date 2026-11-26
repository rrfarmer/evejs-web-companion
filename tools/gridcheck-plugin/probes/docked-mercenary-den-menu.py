from carbonui.util.bunch import Bunch
from eve.client.script.ui.shared.planet.mecDen.mercDenWnd import MyMercDensWnd

def describe(menu):
    return [(entry.GetLabelPath(), entry.GetText()) for entry in menu.GetEntries() if entry is not None]

def row_menu(system_id, complete):
    info = Bunch(item_id=990000013581, type_id=85230, has_complete_info=complete, solar_system_id=system_id)
    return MyMercDensWnd.GetMercDenMenu(None, Bunch(sr=Bunch(node=Bunch(mercDenEntryInfo=info))))

def location(menu):
    return next(entry.GetSubMenuData() for entry in menu.GetEntries()
                if entry is not None and entry.GetLabelPath() == 'UI/Common/Location')

here = row_menu(session.solarsystemid2, True)
remote = row_menu(30000142, True)
result = dict(station=session.stationid, system=session.solarsystemid2, row=describe(here),
              missing=describe(row_menu(session.solarsystemid2, False)),
              hereLocation=describe(location(here)), remoteLocation=describe(location(remote)))
