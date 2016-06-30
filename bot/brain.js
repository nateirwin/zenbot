var numeral = require('numeral')
  , colors = require('colors')
  , tb = require('timebucket')
  , zerofill = require('zero-fill')

module.exports = function container (get, set, clear) {
  return function (options) {
    var bot = options || {}
    var conf = get('conf.bot')
    Object.keys(conf).forEach(function (k) {
      if (typeof bot[k] === 'undefined') {
        bot[k] = JSON.parse(JSON.stringify(conf[k]))
      }
    })
    var initBalance = JSON.parse(JSON.stringify(bot.balance))
    var side = null
    var periodVol = 0
    var runningVol = 0, runningTotal = 0
    var high = 0, low = 10000, vol = 0
    var maxDiff = 0
    var buyPrice = null, sellPrice = null
    var tradeVol = 0
    var cooldown = 0
    var lastTick = null
    var volDiff = ''
    var lastHour = null

    if (bot.tweet) {
      var twitterClient = get('utils.twitterClient')
      function onTweet (err, data, response) {
        if (err) return get('console').error('tweet err', err)
        if (response.statusCode === 200 && data && data.id_str) {
          get('console').log('tweeted: '.cyan + data.text.white)
        }
        else get('console').error('tweet err', response.statusCode, data)
      }
    }
    if (bot.trade) {
      var client = get('utils.gdaxAuthedClient')
      var memId = get('conf.product_id')
      get('console').log('entering zen mode...')
      syncBalance(function (err) {
        if (err) throw err
        bot.trade = false
        get('db.mems').load(memId, function (err, mem) {
          if (err) throw err
          if (mem) {
            side = mem.side
            runningVol = mem.runningVol
            runningTotal = mem.runningTotal
            high = mem.high
            low = mem.low
            vol = mem.vol
            maxDiff = mem.maxDiff
            buyPrice = mem.buyPrice
            sellPrice = mem.sellPrice
            tradeVol = mem.tradeVol
            cooldown = mem.cooldown
            lastTick = mem.lastTick
            lastHour = mem.lastHour
            initBalance = mem.balance // consolidated to currency
            get('console').log('memory loaded. starting trading!')
            bot.trade = true
          }
          else {
            initBalance = JSON.parse(JSON.stringify(bot.balance))
            get('utils.gdaxClient').getProductTicker(function (err, resp, ticker) {
              if (err) throw err
              if (resp.statusCode !== 200) {
                console.error(ticker)
                throw new Error('non-200 status from GDAX: ' + resp.statusCode)
              }
              initBalance.currency += initBalance.asset * ticker.price
              initBalance.asset = 0
            })
            get('console').log('starting trading!')
          }
        })
      })
    }
    function syncBalance (cb) {
      if (!bot.trade) return cb && cb()
      bot.trade = false
      client.getAccounts(function (err, resp, accounts) {
        if (err) throw err
        if (resp.statusCode !== 200) {
          console.error(accounts)
          throw new Error('non-200 status from GDAX: ' + resp.statusCode)
        }
        accounts.forEach(function (account) {
          switch (account.currency) {
            case 'USD':
              bot.balance.currency = parseFloat(account.balance)
              break;
            case 'BTC':
              bot.balance.asset = parseFloat(account.balance)
              break;
          }
        })
        bot.trade = true
        cb && cb()
      })
    }

    function getGraph () {
      runningTotal += ((high + low + lastTick.close) / 3) * periodVol
      runningVol += periodVol
      var vwap = runningTotal / runningVol
      var vwapDiff = lastTick.close - vwap
      maxDiff = Math.max(maxDiff, Math.abs(vwapDiff))
      var barWidth = 20
      var half = barWidth / 2
      var bar = ''
      if (vwapDiff > 0) {
        bar += ' '.repeat(half)
        var stars = Math.min(Math.round((vwapDiff / maxDiff) * half), half)
        bar += '+'.repeat(stars).green.bgGreen
        bar += ' '.repeat(half - stars)
      }
      else if (vwapDiff < 0) {
        var stars = Math.min(Math.round((Math.abs(vwapDiff) / maxDiff) * half), half)
        bar += ' '.repeat(half - stars)
        bar += '-'.repeat(stars).red.bgRed
        bar += ' '.repeat(half)
      }
      else {
        bar += ' '.repeat(half * 2)
      }
      high = 0
      low = 10000
      return bar
    }

    /* report vars

    side = taker side by volume majority of all processed ticks
    vol = positive volume by side, until trigger resets it
    periodVol = trade volume since last report
    high = high price since last report
    low = low price since last report
    cooldown = number of reports until trigger can re-fire
    lastTick = last tick processed
    runningTotal = running volume-weighted typical price
    runningVol = running volume
    buyPrice = price bot last bought at
    sellPrice = price bot last sold at
    tradeVol = total trade volume of bot
    lastHour = hour-granularity timebucket string of last tick processed
    */

    function write (tick) {
      if (!lastTick) {
        initBalance.currency += initBalance.asset * tick.close
        initBalance.asset = 0
      }
      periodVol += tick.vol
      high = Math.max(high, tick.high)
      low = Math.min(low, tick.low)

      if (side && tick.side !== side) {
        vol -= tick.vol
        if (vol < 0) side = tick.side
        vol = Math.abs(vol)
      }
      else {
        side = tick.side
        vol += tick.vol
      }
      var volString = zerofill(3, Math.round(vol), ' ').white
      volDiff = volString + ' ' + (side === 'BUY' ? 'BULL'.green : 'BEAR'.red)
      if (vol >= bot.min_vol) {
        get('console').log(('[bot] volume trigger ' + side + ' ' + numeral(vol).format('0.0') + ' >= ' + numeral(bot.min_vol).format('0.0')).grey)
        vol = 0
        // trigger
        if (side === 'BUY' && !bot.balance.currency) {
          get('console').log('[bot] HOLD'.grey)
          return finish()
        }
        else if (side === 'SELL' && !bot.balance.asset) {
          get('console').log('[bot] HOLD'.grey)
          return finish()
        }
        else if (side === 'BUY') {
          if (cooldown > 0) {
            get('console').log(('[bot] HOLD too soon to BUY').grey)
            return finish()
          }
          cooldown = bot.cooldown
          var delta = 1 - (tick.close / lastTick.close)
          var price = tick.close + (tick.close * bot.markup) // add markup
          var vwap = runningTotal / runningVol
          var vwapDiff = price - vwap
          var spend
          if (vwapDiff > 0) {
            // buy more when price is rising
            spend = bot.balance.currency * bot.trade_amt
          }
          else {
            // buy less when price is falling
            spend = bot.balance.currency * (1 - bot.trade_amt)
          }
          if (spend / price < bot.min_trade) {
            get('console').log(('[bot] HOLD ' + numeral(delta).format('0.000%')).grey)
            return finish()
          }
          if (sellPrice && price > sellPrice) {
            var sellDelta = 1 - (sellPrice / price)
            if (sellDelta >= bot.buy_for_more) {
              get('console').log(('[bot] refusing to BUY for more (sold for ' + numeral(sellPrice).format('$0,0.00') + ') at ' + numeral(price).format('$0,0.00') + ' ' + numeral(sellDelta).format('0.000%')).red)
              return finish()
            }
          }
          if (delta >= bot.crash_protection) {
            get('console').log(('[bot] refusing to BUY at ' + numeral(price).format('$0,0.00') + ': crash protection ' + numeral(delta).format('0.000%')).red)
            cooldown = 0
            return finish()
          }
          buyPrice = price
          bot.balance.currency -= spend
          var size = spend / price
          tradeVol += size
          bot.balance.asset += size
          var fee = (size * price) * bot.fee
          bot.balance.currency -= fee
          get('console').log(('[bot] BUY ' + numeral(size).format('00.000') + ' BTC at ' + numeral(price).format('$0,0.00') + ' ' + numeral(delta).format('0.000%')).cyan)
          if (bot.trade) {
            var buyParams = {
              'type': 'market',
              'size': numeral(size).format('00.000'),
              'product_id': get('conf.product_id'),
            }
            client.buy(buyParams, function (err, resp, result) {
              if (err) return get('console').error('buy err', err, resp, result)
              get('console').log('buy result', resp.statusCode, result)
              if (bot.tweet) {
                var tweet = {
                  status: 'zenbot recommends: BUY #btc at ' + numeral(price).format('$0,0.00') + ' ' + get('utils.getTimestamp')()
                }
                twitterClient.post('statuses/update', tweet, onTweet)
              }
              syncBalance()
            })
          }
        }
        else if (side === 'SELL') {
          if (cooldown > 0) {
            get('console').log(('[bot] HOLD too soon to SELL').grey)
            return finish()
          }
          cooldown = bot.cooldown
          var price = tick.close - (tick.close * bot.markup) // add markup
          var delta = 1 - (lastTick.close / tick.close)
          var vwap = runningTotal / runningVol
          var vwapDiff = price - vwap
          var sell
          if (vwapDiff < 0) {
            // sell more when price is falling
            sell = bot.balance.asset * bot.trade_amt
          }
          else {
            // sell less when price is rising
            sell = bot.balance.asset * (1 - bot.trade_amt) / 2
          }
          if (sell < bot.min_trade) {
            get('console').log(('[bot] HOLD' + numeral(delta).format('0.000%')).grey)
            return finish()
          }
          if (buyPrice && price < buyPrice) {
            var buyDelta = 1 - (price / buyPrice)
            if (buyDelta >= bot.sell_for_less) {
            get('console').log(('[bot] refusing to SELL for less (bought for ' + numeral(buyPrice).format('$0,0.00') + ') at ' + numeral(price).format('$0,0.00') + ' ' + numeral(buyDelta).format('0.000%')).red)
              return finish()
            }
          }
          if (delta >= bot.crash_protection) {
            get('console').log(('[bot] refusing to SELL at ' + numeral(price).format('$0,0.00') + ': crash protection ' + numeral(delta).format('0.000%')).red)
            cooldown = 0
            return finish()
          } 
          sellPrice = price
          bot.balance.asset -= sell
          tradeVol += sell
          bot.balance.currency += sell * price
          var fee = (sell * price) * bot.fee
          bot.balance.currency -= fee
          get('console').log(('[bot] SELL ' + numeral(sell).format('00.000') + ' BTC at ' + numeral(price).format('$0,0.00') + ' ' + numeral(delta).format('0.000%')).cyan)
          if (bot.trade) {
            var sellParams = {
              'type': 'market',
              'size': numeral(sell).format('00.000'),
              'product_id': get('conf.product_id'),
            }
            client.sell(sellParams, function (err, resp, result) {
              if (err) return get('console').error('sell err', err, resp, result)
              get('console').log('sell result', resp.statusCode, result)
              if (bot.tweet) {
                var tweet = {
                  status: 'zenbot recommends: SELL #btc at ' + numeral(price).format('$0,0.00') + ' ' + get('utils.getTimestamp')()
                }
                twitterClient.post('statuses/update', tweet, onTweet)
              }
              syncBalance()
            })
          }
        }
      }
      finish()
      function finish () {
        lastTick = tick
      }
    }
    function end () {
      var newBalance = JSON.parse(JSON.stringify(bot.balance))
      if (lastTick) {
        newBalance.currency += newBalance.asset * lastTick.close
        newBalance.asset = 0
      }
      return {
        asset: newBalance.asset,
        currency: newBalance.currency,
        close: lastTick ? lastTick.close : null
      }
    }
    function report () {
      if (cooldown) cooldown--
      var time = get('utils.getTimestamp')(lastTick.time)
      var bar = getGraph()
      periodVol = 0
      var newBalance = JSON.parse(JSON.stringify(bot.balance))
      newBalance.currency += newBalance.asset * lastTick.close
      newBalance.asset = 0
      var diff = newBalance.currency - initBalance.currency
      if (diff > 0) diff = ('+' + numeral(diff).format('$0,0.00')).green
      if (diff === 0) diff = ('+' + numeral(diff).format('$0,0.00')).white
      if (diff < 0) diff = (numeral(diff).format('$0,0.00')).red
      var status = [
        bar,
        numeral(lastTick.close).format('$0,0.00').yellow,
        volDiff,
        time.grey,
        numeral(bot.balance.asset).format('00.000').white,
        'BTC/USD'.grey,
        numeral(bot.balance.currency).format('$,0.00').yellow,
        diff
      ].join(' ')
      get('console').log(status)
      var thisHour = tb(lastTick.time).resize('1h').toString()
      if (thisHour !== lastHour) {
        if (bot.tweet) {
          var plainBar = colors.strip(bar)
          var plusMatch = plainBar.match(/\+/g)
          var pct = '0%'
          if (plusMatch) {
            pct = '+' + (plusMatch.length * 10) + '%'
          }
          var minusMatch = plainBar.match(/\-/g)
          if (minusMatch) {
            pct = '-' + (minusMatch.length * 10) + '%'
          }
          var text = [
            'report:',
            pct,
            numeral(lastTick.close).format('$0,0.00'),
            volDiff,
            time,
            '#btc'
          ].join(' ').trim()
          var tweet = {
            status: colors.strip(text).replace(/\s+/g, ' ')
          }
          twitterClient.post('statuses/update', tweet, onTweet)
        }
      }
      lastHour = thisHour
      if (bot.trade) {
        var mem = {
          id: memId,
          side: side,
          runningVol: runningVol,
          runningTotal: runningTotal,
          high: high,
          low: low,
          vol: vol,
          maxDiff: maxDiff,
          buyPrice: buyPrice,
          sellPrice: sellPrice,
          tradeVol: tradeVol,
          cooldown: cooldown,
          lastTick: lastTick,
          lastHour: lastHour,
          balance: newBalance
        }
        get('db.mems').save(mem, function (err, saved) {
          if (err) return get('console').error('mem save err', err)
        })
        syncBalance()
      }
    }
    return {
      write: write,
      end: end,
      report: report
    }
  }
}