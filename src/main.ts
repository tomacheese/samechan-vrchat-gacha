import { Twitter } from '@book000/twitterts'
import { Logger } from '@book000/node-utils'
import { Browser, Frame, Page } from 'puppeteer-core'
import axios from 'axios'
import fs from 'node:fs'

/**
 * 要素が見つかったかどうかを返す
 *
 * @param target 対象のページまたはフレーム
 * @param selector セレクター
 * @returns 要素が見つかったかどうか
 */
async function isFoundElement(target: Page | Frame, selector: any) {
  return target.$(selector).then((el: any) => !!el)
}

/**
 * ツイートのスクリーンショットを取得する
 *
 * @param browser ブラウザ
 * @param directory 保存先ディレクトリパス
 * @param screenName スクリーンネーム
 * @param tweetId ツイートID
 * @returns 保存されたファイル名
 */
async function getTweetScreenshot(
  browser: Browser,
  directory: string,
  screenName: string,
  tweetId: string
) {
  const logger = Logger.configure('getOembedPageScreenshot')
  logger.info('✨ getOembedPageScreenshot()')

  const filename = `${screenName}-${tweetId}.png`
  const path = `${directory}/${filename}`
  if (fs.existsSync(path)) {
    logger.info(`🔍 Already downloaded, skip: ${tweetId}`)
    return filename
  }

  const tweetUrl = `https://twitter.com/${screenName}/status/${tweetId}`
  const url = `https://publish.twitter.com/oembed?url=${tweetUrl}&partner=&hide_thread=false`

  // publish.twitter.com から HTML を取得
  logger.info(`🔍 Fetching oEmbed page: ${url}`)
  const response = await axios.get<{
    html: string
  }>(url)
  const html = response.data.html

  // HTML を Puppeteer でレンダリング
  const page = await browser.newPage()
  await page.setContent(html, {
    waitUntil: 'domcontentloaded',
  })
  const frame = await page
    .waitForSelector('#twitter-widget-0')
    .then((el) => el?.contentFrame())
  if (!frame) {
    throw new Error('Frame is not found')
  }
  await frame.waitForNavigation({ waitUntil: 'networkidle0' })

  // センシティブボタンがあればクリック
  const sensitiveButtonSelector = 'div[role="button"].css-18t94o4'
  if (await isFoundElement(frame, sensitiveButtonSelector)) {
    const buttonText = await frame.$eval(
      sensitiveButtonSelector,
      (el) => el.textContent
    )
    if (buttonText?.includes('View')) {
      await frame.click(sensitiveButtonSelector)
      logger.info('View button is clicked')
    }
  }

  const frameWidth = await frame.evaluate(() => {
    return document.body.scrollWidth
  })
  const frameHeight = await frame.evaluate(() => {
    return document.body.scrollHeight
  })

  logger.info(`🖼 Frame size: ${frameWidth}x${frameHeight}`)

  // スクロールバーを非表示にして、スクリーンショットを取得
  await page.evaluate(() => {
    document.documentElement.style.overflow = 'hidden'
  })
  await frame.evaluate(() => {
    document.documentElement.style.overflow = 'hidden'
  })
  await page.setViewport({
    width: frameWidth,
    height: frameHeight,
  })

  await page.screenshot({ path })

  return filename
}

async function fetch(twitter: Twitter) {
  const logger = Logger.configure('fetch')
  logger.info('✨ fetch()')

  const directory = process.env.BASE_DIRECTORY ?? './screenshots'
  if (fs.existsSync(directory)) {
    // 中身を削除。ディレクトリ自体は削除しない
    const items = fs.readdirSync(directory)
    for (const item of items) {
      fs.rmSync(`${directory}/${item}`, { recursive: true })
    }
  }
  fs.mkdirSync(directory, { recursive: true })

  logger.info('🔍 Fetching tweets...')
  const tweets = await twitter.getUserTweets({
    screenName: 'SameGauu',
    limit: 100,
  })
  logger.info(`🔍 Fetched ${tweets.length} tweets`)

  const browser = twitter.scraper.getBrowser()
  if (!browser) {
    throw new Error('Browser is not initialized')
  }

  // ツイート分スクリーンショットを取得
  const filenames = []
  for (const tweet of tweets) {
    const screenName = 'screen_name' in tweet.user ? tweet.user.screen_name : ''
    const isRetweet = 'retweeted_status' in tweet
    if (isRetweet) {
      logger.info(`🔄 Skip retweet: ${tweet.id_str}`)
      continue
    }
    const tweetId = tweet.id_str
    const filename = await getTweetScreenshot(
      browser,
      directory,
      screenName,
      tweetId
    ).catch(null)
    if (!filename) {
      logger.warn(`🚫 Failed to get screenshot: ${tweetId}`)
      continue
    }

    logger.info(`📸 Screenshot saved ${filename}`)

    filenames.push(filename)
  }

  // ファイル名を保存
  const savePath = `${directory}/filenames.json`
  fs.writeFileSync(savePath, JSON.stringify(filenames, null, 2))

  logger.info(`🎉 Finished. Count: ${filenames.length}`)

  generateIndex(directory, filenames)
}

function generateIndex(directory: string, filenames: string[]) {
  const logger = Logger.configure('generateIndex')
  logger.info('✨ generateIndex()')

  const html = fs.readFileSync('template.html', 'utf8')
  const items = filenames
    .map((filename) => {
      return `<img src="${filename}" alt="${filename}" />`
    })
    .join('\n')

  const indexHtml = html.replace('<!-- items -->', items)
  fs.writeFileSync(`${directory}/index.html`, indexHtml)
}

/**
 * メイン処理
 */
async function main() {
  const logger = Logger.configure('main')
  logger.info('✨ main()')

  if (!process.env.TWITTER_USERNAME || !process.env.TWITTER_PASSWORD) {
    throw new Error('TWITTER_USERNAME, TWITTER_PASSWORD is not set')
  }

  const proxyServer = process.env.PROXY_SERVER
  const proxyUsername = process.env.PROXY_USERNAME
  const proxyPassword = process.env.PROXY_PASSWORD
  const proxyConfiguration = proxyServer
    ? {
        server: proxyServer,
        username: proxyUsername,
        password: proxyPassword,
      }
    : undefined

  logger.info('🚪 Logging in...')
  const twitter = await Twitter.login({
    username: process.env.TWITTER_USERNAME,
    password: process.env.TWITTER_PASSWORD,
    otpSecret: process.env.TWITTER_AUTH_CODE_SECRET,
    emailAddress: process.env.TWITTER_EMAIL_ADDRESS,
    puppeteerOptions: {
      executablePath: process.env.CHROMIUM_PATH,
      userDataDirectory: process.env.USER_DATA_DIRECTORY ?? './data/userdata',
      proxy: proxyConfiguration,
    },
    debugOptions: {
      outputResponse: {
        enable: process.env.DEBUG_OUTPUT_RESPONSE === 'true',
        onResponse: (response) => {
          logger.info(`📦 Response: ${response.type} ${response.name}`)
        },
      },
    },
  })

  await fetch(twitter).catch((error: unknown) => {
    logger.error('❌ Error occurred in fetch', error as Error)
  })

  await twitter.close()
}

;(async () => {
  await main()
})()
