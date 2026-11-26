from carbonui.util.bunch import Bunch
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from evelink.client.handlers.show_info.link import location_link
from eve.client.script.ui.shared.planet.mecDen.mercDenWnd import MyMercDensWnd
from eve.client.script.parklife.fleetSvc import FleetSvc
from menucheckers.sessionChecker import SessionChecker

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
operation_link = location_link(30000142)
link_service = sm.GetService('link')
solo_link = describe(CreateMenuDataFromRawTuples(link_service.get_menu(operation_link.url)))

class FleetSession(object):
    fleetid = 1

    def __getattr__(self, attr):
        return getattr(session, attr)

menu_service = sm.GetService('menu')
original_checker = menu_service.sessionChecker
try:
    menu_service.sessionChecker = SessionChecker(FleetSession(), sm)
    fleet_location = location(row_menu(30000142, True))
    fleet_link = describe(CreateMenuDataFromRawTuples(link_service.get_menu(operation_link.url)))
finally:
    menu_service.sessionChecker = original_checker

calls = []
FleetSvc.SendBroadcast_TravelTo.im_func(Bunch(SendGlobalBroadcast=lambda *args: calls.append(args)), 30000142, 5)
try:
    FleetSvc.CheckIsInFleet.im_func(Bunch(fleet=object()), inSpace=True)
    refusal = None
except UserError as error:
    refusal = error.msg

result = dict(station=session.stationid, system=session.solarsystemid2, row=describe(here),
              missing=describe(row_menu(session.solarsystemid2, False)), hereLocation=describe(location(here)),
              remoteLocation=describe(location(remote)), fleetLocation=describe(fleet_location),
              soloLink=solo_link, fleetLink=fleet_link, arguments=calls, refusal=refusal)
