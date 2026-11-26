from eve.client.script.ui.shared.info import infosvc


def observe():
    info = sm.GetService('info')
    world = sm.GetService('map')
    result = {}
    pick = infosvc.GetFromClass
    try:
        infosvc.GetFromClass = lambda _, data: data
        for station in (60015169, 60003760, session.stationid):
            rows = info.GetServicesForStation(world.GetStation(station), station, iconoffset=20)
            result[station] = [[row['label'], row['icon'], bool(row['standingsRestriction'])] for row in rows]
    finally:
        infosvc.GetFromClass = pick
    return dict(station=session.stationid, services=result)


result = observe()
