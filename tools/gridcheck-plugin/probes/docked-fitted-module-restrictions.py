from evedungeons.client.data import GetDungeons


def observe():
    dungeons = GetDungeons()
    connected = 0
    connections = 0
    unknown = 0
    fitted_lists = []
    for dungeon_id, dungeon in dungeons.iteritems():
        if dungeon.connections:
            connected += 1
        for connection in dungeon.connections or ():
            connections += 1
            if not hasattr(connection, 'disallowedFittedTypesList'):
                unknown += 1
                continue
            list_id = connection.disallowedFittedTypesList
            if list_id:
                fitted_lists.append([dungeon_id, connection.fromObjectID, list_id])
    return dict(build=3698585, station=session.stationid, dungeons=len(dungeons),
                connected=connected, connections=connections, unknown=unknown,
                fittedLists=sorted(fitted_lists))


result = observe()
