import { registerBundledSkill } from '../bundledSkills.js'

// 已验证的单分词词汇（通过API分词计数测试）
// 所有常用英文单词均确认为单分词形式
const ONE_TOKEN_WORDS = [
  // 冠词 & 代词
  'the',
  'a',
  'an',
  'I',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'its',
  'our',
  'this',
  'that',
  'what',
  'who',
  // 常用动词
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'can',
  'could',
  'may',
  'might',
  'must',
  'shall',
  'should',
  'make',
  'made',
  'get',
  'got',
  'go',
  'went',
  'come',
  'came',
  'see',
  'saw',
  'know',
  'take',
  'think',
  'look',
  'want',
  'use',
  'find',
  'give',
  'tell',
  'work',
  'call',
  'try',
  'ask',
  'need',
  'feel',
  'seem',
  'leave',
  'put',
  // 常用名词 & 形容词
  'time',
  'year',
  'day',
  'way',
  'man',
  'thing',
  'life',
  'hand',
  'part',
  'place',
  'case',
  'point',
  'fact',
  'good',
  'new',
  'first',
  'last',
  'long',
  'great',
  'little',
  'own',
  'other',
  'old',
  'right',
  'big',
  'high',
  'small',
  'large',
  'next',
  'early',
  'young',
  'few',
  'public',
  'bad',
  'same',
  'able',
  // 介词 & 连词
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'from',
  'by',
  'about',
  'like',
  'through',
  'over',
  'before',
  'between',
  'under',
  'since',
  'without',
  'and',
  'or',
  'but',
  'if',
  'than',
  'because',
  'as',
  'until',
  'while',
  'so',
  'though',
  'both',
  'each',
  'when',
  'where',
  'why',
  'how',
  // 常用副词
  'not',
  'now',
  'just',
  'more',
  'also',
  'here',
  'there',
  'then',
  'only',
  'very',
  'well',
  'back',
  'still',
  'even',
  'much',
  'too',
  'such',
  'never',
  'again',
  'most',
  'once',
  'off',
  'away',
  'down',
  'out',
  'up',
  // 技术/常用词汇
  'test',
  'code',
  'data',
  'file',
  'line',
  'text',
  'word',
  'number',
  'system',
  'program',
  'set',
  'run',
  'value',
  'name',
  'type',
  'state',
  'end',
  'start',
]

function generateLoremIpsum(targetTokens: number): string {
  let tokens = 0
  let result = ''

  while (tokens < targetTokens) {
    // 句子：10-20个单词
    const sentenceLength = 10 + Math.floor(Math.random() * 11)
    let wordsInSentence = 0

    for (let i = 0; i < sentenceLength && tokens < targetTokens; i++) {
      const word =
        ONE_TOKEN_WORDS[Math.floor(Math.random() * ONE_TOKEN_WORDS.length)]
      result += word
      tokens++
      wordsInSentence++

      if (i === sentenceLength - 1 || tokens >= targetTokens) {
        result += '. '
      } else {
        result += ' '
      }
    }

    // 每5-8个句子分段（每个句子约20%概率换行）
    if (wordsInSentence > 0 && Math.random() < 0.2 && tokens < targetTokens) {
      result += '\n\n'
    }
  }

  return result.trim()
}

export function registerLoremIpsumSkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  registerBundledSkill({
    name: 'lorem-ipsum',
    description:
      '生成长上下文测试用填充文本。指定分词数量作为参数（例如：/lorem-ipsum 50000）。输出约等于请求数量的分词。仅蚂蚁用户可用。',
    argumentHint: '[分词数量]',
    userInvocable: true,
    async getPromptForCommand(args) {
      const parsed = parseInt(args)

      if (args && (isNaN(parsed) || parsed <= 0)) {
        return [
          {
            type: 'text',
            text: '无效的分词数量。请提供一个正整数（例如：/lorem-ipsum 10000）。',
          },
        ]
      }

      const targetTokens = parsed || 10000

      // 为安全起见，上限设为50万分词
      const cappedTokens = Math.min(targetTokens, 500_000)

      if (cappedTokens < targetTokens) {
        return [
          {
            type: 'text',
            text: `请求${targetTokens}个分词，但为安全起见已上限限制为500000个。\n\n${generateLoremIpsum(cappedTokens)}`,
          },
        ]
      }

      const loremText = generateLoremIpsum(cappedTokens)

      // 直接将填充文本输出到对话中
      return [
        {
          type: 'text',
          text: loremText,
        },
      ]
    },
  })
}