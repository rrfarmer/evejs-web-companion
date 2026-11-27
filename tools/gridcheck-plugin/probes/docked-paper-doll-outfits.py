def observe():
    outfits = []
    for row in cfg.paperdollResources:
        path = row.resPath.lower()
        if '/outer/catsuit01/types/' in '/' + path or '/outer/armorsuitcf01/types/' in '/' + path:
            outfits.append(dict(resourceID=row.paperdollResourceID, gender=row.resGender, typeID=row.typeID, path=path))
    if not outfits:
        raise RuntimeError('No complete outfit resources in the client catalog')
    locations = [dict(id=row.modifierLocationID, key=row.modifierKey, variation=row.variationKey)
                 for row in cfg.paperdollModifierLocations if row.modifierKey in ('outer', 'hair')]
    if set(row['key'] for row in locations) != set(('outer', 'hair')):
        raise RuntimeError('Missing outer or hair modifier locations')
    hair = [dict(resourceID=row.paperdollResourceID, gender=row.resGender, path=row.resPath)
            for row in cfg.paperdollResources if row.resPath.lower() == 'hair/hair_bob_02/types/hair_bob_02.type']
    return dict(station=session.stationid, outfits=outfits, locations=locations, hair=hair)


result = observe()
