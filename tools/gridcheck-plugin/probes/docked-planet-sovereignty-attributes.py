from eve.common.script.util.eveFormat import FmtPlanetAttributeKeyVal


def observe():
    info = sm.GetService('info')
    samples = []
    for planet_id in (40009229, 40239109, 40239111, 40239179, 40239204):
        sov = info.GetSovStatisticsForPlanet(planet_id)
        rows = []
        for key, value in sov.iteritems():
            label, text, type_id = FmtPlanetAttributeKeyVal(key, value)
            rows.append(dict(key=key, label=label, text=text, typeID=type_id, value=value))
        samples.append(dict(itemID=planet_id, systemID=info.map.GetParentLocationID(planet_id)[3], rows=rows))
    return dict(build=3698585, station=session.stationid, samples=samples)


result = observe()
