import hashlib
import blue


def observe():
    if not session.stationid and not session.structureid:
        raise RuntimeError('The reference pilot is not docked')
    recent = sm.RemoteSvc('charMgr').GetRecentShipKillsAndLosses(25, None)
    report = next((each for each in recent if each.victimCharacterID), None)
    if report is None:
        raise RuntimeError('The reference pilot has no character loss report')
    photo = sm.GetService('photo')
    character_id = report.victimCharacterID
    size = photo.GetPortraitSaveSize()
    photo.GetPortrait(character_id, 128, blocking=True)
    image = photo.portraits.GetImage(character_id, size, forceUpdate=True)
    count = 0
    digest = None
    if image:
        with open(blue.paths.ResolvePath(image), 'rb') as image_file:
            data = image_file.read()
        count = len(data)
        digest = hashlib.sha256(data).hexdigest()
    return dict(station=session.stationid, structure=session.structureid, characterID=character_id,
                size=size, filename='%s.jpg' % character_id, bytes=count, sha256=digest)


result = observe()
