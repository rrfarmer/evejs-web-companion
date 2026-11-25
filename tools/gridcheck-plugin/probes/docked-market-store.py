import blue
from eve.client.script.ui.shared.market.marketbase import RegionalMarket
from localization import GetByLabel


def wait_for(predicate):
    for _ in xrange(50):
        if predicate():
            return True
        blue.synchro.SleepWallclock(100)
    return False


def observe():
    views = sm.GetService('viewState')
    cmd = sm.GetService('cmd')
    view = 'virtual_goods_store'
    if RegionalMarket.GetIfOpen() or views.IsViewActive(view):
        return {'alreadyOpen': True}
    try:
        cmd.OpenMarket()
        market = RegionalMarket.GetIfOpen()
        button = market.sr.market.marketNESButton
        observation = {'station': session.stationid, 'windowID': market.default_windowID,
                       'label': GetByLabel('UI/VirtualGoodsStore/VgsName'),
                       'command': button.func.__name__}
        button.OnClick()
        observation['opened'] = wait_for(lambda: views.IsViewActive(view))
        if observation['opened']:
            button.OnClick()
            observation['closed'] = wait_for(lambda: not views.IsViewActive(view))
        observation['sameMarket'] = RegionalMarket.GetIfOpen() is market
        return observation
    finally:
        if views.IsViewActive(view):
            views.CloseSecondaryView()
        market = RegionalMarket.GetIfOpen()
        if market:
            market.Close()


result = observe()
