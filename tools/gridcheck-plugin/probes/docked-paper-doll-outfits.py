def observe():
    outfits = []
    for row in cfg.paperdollResources:
        path = row.resPath.lower()
        if '/outer/catsuit01/types/' in '/' + path or '/outer/armorsuitcf01/types/' in '/' + path:
            outfits.append(dict(resourceID=row.paperdollResourceID, gender=row.resGender, typeID=row.typeID, path=path))
    if not outfits:
        raise RuntimeError('No complete outfit resources in the client catalog')
    return dict(station=session.stationid, outfits=outfits)


result = observe()
