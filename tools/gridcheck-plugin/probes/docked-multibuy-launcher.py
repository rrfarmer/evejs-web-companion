# Observe the empty Neocom Multibuy and its behavior when a shopping list is open.
from eve.client.script.ui.shared.market.buyMultiFromBase import MultiBuy
from eveexceptions import UserError
from localization import GetByLabel
from shipfitting.multiBuyUtil import BuyMultipleTypesWithQty


def observe():
    cmd = sm.GetService('cmd')
    observation = {'station': session.stationid,
                   'menuLabel': GetByLabel(cmd.OpenMultibuy.nameLabelPath),
                   'alreadyOpen': bool(MultiBuy.GetIfOpen())}
    if observation['alreadyOpen']:
        return observation
    try:
        cmd.OpenMultibuy()
        window = MultiBuy.GetIfOpen()
        observation['opened'] = bool(window)
        if not window:
            return observation
        observation['windowID'] = window.default_windowID
        observation['emptyRows'] = len(window.itemList)
        observation['stationSelection'] = window.stationCombo.GetValue()
        observation['emptyFitting'] = window.fitting is None
        try:
            BuyMultipleTypesWithQty({483: 2})
        except UserError as error:
            observation['quoteError'] = unicode(error)
        observation['seededTypeIDs'] = sorted(window.entriesInScrollByTypeID)
        window.Minimize(animate=False)
        observation['minimized'] = window.IsMinimized()
        cmd.OpenMultibuy()
        observation['sameWindow'] = MultiBuy.GetIfOpen() is window
        observation['restored'] = not window.IsMinimized()
        observation['keptTypeIDs'] = sorted(window.entriesInScrollByTypeID)
        return observation
    finally:
        window = MultiBuy.GetIfOpen()
        if window:
            window.Close()


result = observe()
