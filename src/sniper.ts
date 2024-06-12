import {
  TokenAmount,
  Token,
  TokenAccount,
  MARKET_STATE_LAYOUT_V3,
  TOKEN_PROGRAM_ID,
  LiquidityStateV4,
  MarketStateV3,
} from '@raydium-io/raydium-sdk';
import { AccountLayout, RawAccount, getMint } from '@solana/spl-token';
import {
  Commitment,
  GetVersionedTransactionConfig,
  KeyedAccountInfo,
  PublicKey,
  Transaction,
  TransactionConfirmationStrategy,
} from '@solana/web3.js';
import { buy, getTokenAccounts, saveTokenAccount, sell } from './cryptoQueries';
import logger from './utils/logger';
import { solanaConnection, wallet } from './solana';
import { OPENBOOK_PROGRAM_ID, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4 } from './cryptoQueries/raydiumSwapUtils/liquidity';
import { MinimalTokenAccountData } from './cryptoQueries/cryptoQueries.types';
import BigNumber from 'bignumber.js';
import WebSocket from 'ws';
import { exit } from 'process';
import { sendMessage } from './telegramBot';
import { getTokenPrice } from './birdEye';
import { Market, OpenOrders } from '@project-serum/serum';
import { helius } from './helius';
import { DEFAULT_TRANSACTION_COMMITMENT } from './constants';
import { Block } from './listener.types';
import { isNumberInRange } from './utils/mathUtils';
let existingTokenAccounts: TokenAccount[] = [];

const quoteToken = Token.WSOL;
let swapAmount: TokenAmount;
let quoteTokenAssociatedAddress: PublicKey;
const existingTokenAccountsExtended: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();
let currentTokenKey = '';
let bignumberInitialPrice: BigNumber | undefined = undefined;
let wsPairs: WebSocket | undefined = undefined;
let ws: WebSocket | undefined = undefined;
const stopLossPrecents = Number(process.env.STOP_LOSS_PERCENTS!) * -1;
const takeProfitPercents = Number(process.env.TAKE_PROFIT_PERCENTS!);
const timoutSec = Number(process.env.SELL_TIMEOUT_SEC!);
let processingToken = false;
let gotWalletToken = false;

let lastRequest: any | undefined = undefined;
let foundTokenData: RawAccount | undefined = undefined;
let timeToSellTimeoutGeyser: Date | undefined = undefined;
let sentBuyTime: Date | undefined = undefined;
let currentTokenSwaps = 0;
const maxLamports = 1200010;
let currentLamports = maxLamports;
let lastBlocks: Block[] = [];
export default async function snipe(): Promise<void> {
  setInterval(storeRecentBlockhashes, 500);
  await new Promise((resolve) => setTimeout(resolve, 140000));
  logger.info('Started listening');
  //https://solscan.io/tx/Kvu4Qd5RBjUDoX5yzUNNtd17Bhb78qTo93hqYgDEr8hb1ysTf9zGFDgvS1QTnz6ghY3f6Fo59GWYQSgkTJxo9Cd mintundefined
  // skipped https://www.dextools.io/app/en/solana/pair-explorer/HLBmAcU65tm999f3WrshSdeFgAbZNxEGrqD6DzAdR1iF?t=1717674277533 because of jitotip, not sure if want to fix
  setupPairSocket();
  setupLiquiditySocket();
  await updateLamports();
  setInterval(updateLamports, 15000);
  logger.info(`Wallet Address: ${wallet.publicKey}`);
  swapAmount = new TokenAmount(Token.WSOL, process.env.SWAP_SOL_AMOUNT, false);
  logger.info(`Swap sol amount: ${swapAmount.toFixed()} ${quoteToken.symbol}`);
  existingTokenAccounts = await getTokenAccounts(
    solanaConnection,
    wallet.publicKey,
    process.env.COMMITMENT as Commitment,
  );
  const tokenAccount = existingTokenAccounts.find(
    (acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString(),
  )!;
  if (!tokenAccount) {
    throw new Error(`No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`);
  }
  quoteTokenAssociatedAddress = tokenAccount.pubkey;
  await listenToChanges();
}

async function getFinalizedBlockheight(): Promise<number> {
  const currentSlot = await solanaConnection.getSlot('finalized');
  let block = undefined;
  for (let i = 0; i < 5; i += 1) {
    try {
      block = (await solanaConnection.getBlock(currentSlot - 2, {
        transactionDetails: 'none',
        maxSupportedTransactionVersion: 0,
      })) as any;
      break;
    } catch (e) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (block === undefined) throw 'Could not fetch block';
  return block.blockHeight;
}
async function getBlockForBuy() {
  const currentHeight = await getFinalizedBlockheight();
  const lastBlock = lastBlocks[lastBlocks.length - 1];
  const diff = lastBlock.lastValidBlockHeight - currentHeight;
  const min = lastBlock.lastValidBlockHeight - diff * 0.265;
  const max = lastBlock.lastValidBlockHeight - diff * 0.2;

  const block = lastBlocks.find((x) => isNumberInRange(x.lastValidBlockHeight, min, max));
  return block!;
}

async function storeRecentBlockhashes() {
  const block = await solanaConnection.getLatestBlockhash('finalized');
  if (lastBlocks.length > 500) lastBlocks.splice(0, 100);
  lastBlocks.push(block);
}

async function updateLamports() {
  const prices = await helius.rpc.getPriorityFeeEstimate({
    accountKeys: ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'],
    options: { includeAllPriorityFeeLevels: true },
  });
  if (prices.priorityFeeLevels?.high === undefined || maxLamports < prices.priorityFeeLevels?.high) {
    currentLamports = maxLamports;
  } else {
    currentLamports = Math.floor(prices.priorityFeeLevels?.high + 10000);
  }
}

function setupLiquiditySocket() {
  ws = new WebSocket(process.env.GEYSER_ENDPOINT!);
  ws.on('open', function open() {
    logger.info('Listening to geyser liquidity');
    const request = {
      jsonrpc: '2.0',
      id: 420,
      method: 'transactionSubscribe',
      params: [
        {
          vote: false,
          failed: false,
          accountRequired: [
            'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
            RAYDIUM_LIQUIDITY_PROGRAM_ID_V4.toString(),
            'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
            '9DCxsMizn3H1hprZ7xWe6LDzeUeZBksYFpBWBtSf1PQX',
          ],
        },
        {
          commitment: 'processed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          showRewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
    };
    ws!.send(JSON.stringify(request));
  });
  ws.on('message', async function incoming(data) {
    if (processingToken) return;
    const messageStr = data.toString();
    try {
      var jData = JSON.parse(messageStr);
      const isntructions = jData?.params?.result?.transaction?.meta?.innerInstructions;
      if (isntructions && isntructions.length === 1) {
        const inner = isntructions[0].instructions;
        if (inner[inner.length - 1]?.parsed?.type === 'mintTo') {
          if (processingToken) return;
          processingToken = true;
          const mint1 = inner[12];
          const mint2 = inner[16];
          const isFirstMintSol = mint1.parsed.info.mint === 'So11111111111111111111111111111111111111112';
          const mintAddress = isFirstMintSol ? mint2.parsed.info.mint : mint1.parsed.info.mint;
          logger.info('Mint ' + mintAddress);
          let mintAccount = undefined;
          for (let i = 0; i < 10; i += 1) {
            try {
              mintAccount = await getMint(
                solanaConnection,
                new PublicKey(mintAddress),
                process.env.COMMITMENT as Commitment,
              );
              if (mintAccount) break;
            } catch (e) {
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          }
          if (!mintAccount) throw 'Failed to get mint ';

          if (mintAccount.freezeAuthority !== null) {
            logger.warn('Token can be frozen, skipping');
            processingToken = false;
            return;
          }
          logger.info('Listening to geyser Pair');
          lastRequest = {
            jsonrpc: '2.0',
            id: 420,
            method: 'transactionSubscribe',
            params: [
              {
                vote: false,
                failed: false,
                accountInclude: [mintAddress],
              },
              {
                commitment: 'processed',
                encoding: 'jsonParsed',
                transactionDetails: 'full',
                showRewards: false,
                maxSupportedTransactionVersion: 1,
              },
            ],
          };
          if (wsPairs?.readyState === wsPairs?.OPEN) wsPairs!.send(JSON.stringify(lastRequest));
          const sampleKeys = {
            status: undefined,
            owner: new PublicKey('So11111111111111111111111111111111111111112'),
            nonce: undefined,
            maxOrder: undefined,
            depth: undefined,
            baseDecimal: Number(mintAccount.decimals),
            quoteDecimal: 9,
            state: undefined,
            resetFlag: undefined,
            minSize: undefined,
            volMaxCutRatio: undefined,
            amountWaveRatio: undefined,
            baseLotSize: undefined,
            quoteLotSize: undefined,
            minPriceMultiplier: undefined,
            maxPriceMultiplier: undefined,
            systemDecimalValue: undefined,
            minSeparateNumerator: undefined,
            minSeparateDenominator: undefined,
            tradeFeeNumerator: undefined,
            tradeFeeDenominator: undefined,
            pnlNumerator: undefined,
            pnlDenominator: undefined,
            swapFeeNumerator: undefined,
            swapFeeDenominator: undefined,
            baseNeedTakePnl: undefined,
            quoteNeedTakePnl: undefined,
            quoteTotalPnl: undefined,
            baseTotalPnl: undefined,
            poolOpenTime: undefined,
            punishPcAmount: undefined,
            punishCoinAmount: undefined,
            orderbookToInitTime: undefined,
            swapBaseInAmount: undefined,
            swapQuoteOutAmount: undefined,
            swapBase2QuoteFee: undefined,
            swapQuoteInAmount: inner[30].parsed.info.amount,
            swapBaseOutAmount: undefined,
            swapQuote2BaseFee: undefined,
            baseVault: new PublicKey(inner[12].parsed.info.account),
            quoteVault: new PublicKey(inner[15].parsed.info.account),
            baseMint: isFirstMintSol
              ? new PublicKey('So11111111111111111111111111111111111111112')
              : new PublicKey(mintAddress),
            quoteMint: isFirstMintSol
              ? new PublicKey(mintAddress)
              : new PublicKey('So11111111111111111111111111111111111111112'), //was q sol
            lpMint: new PublicKey(inner[31].parsed.info.mint),
            openOrders: new PublicKey(inner[22].parsed.info.account),
            marketId: new PublicKey(inner[23].accounts[2]),
            marketProgramId: new PublicKey(inner[23].programId),
            targetOrders: new PublicKey(inner[4].parsed.info.account),
            withdrawQueue: new PublicKey('11111111111111111111111111111111'),
            lpVault: new PublicKey('11111111111111111111111111111111'),
            lpReserve: undefined,
            padding: [],
          };
          currentTokenKey = mintAddress;
          try {
            const packet = await processGeyserLiquidity(
              new PublicKey(inner[inner.length - 13].parsed.info.account),
              sampleKeys,
              new PublicKey(mintAddress),
            );
            sentBuyTime = new Date();
            solanaConnection
              .confirmTransaction(packet as TransactionConfirmationStrategy, 'finalized')
              .then(async (confirmation) => {
                if (confirmation.value.err) {
                  logger.warn('Sent buy bundle but it failed');
                  processingToken = false;
                  lastRequest = undefined;
                  wsPairs?.close();
                } else {
                  await new Promise((resolve) => setTimeout(resolve, 5000));

                  if (!foundTokenData && !bignumberInitialPrice && processingToken && !gotWalletToken) {
                    logger.warn('Websocket took too long');
                    const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, 'processed');
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    logger.info('Currentkey ' + currentTokenKey);
                    const tokenAccount = tokenAccounts.find(
                      (acc) => acc.accountInfo.mint.toString() === currentTokenKey,
                    )!;
                    if (!tokenAccount) {
                      logger.info(`No token account found in wallet, but it succeeded`);
                      return;
                    }
                    logger.warn(`Selling bc didnt get token`);
                    sellOnActionGeyser({
                      ...tokenAccount.accountInfo,
                      delegateOption: tokenAccount.accountInfo.delegateOption === 1 ? 1 : 0,
                      isNativeOption: tokenAccount.accountInfo.isNativeOption === 1 ? 1 : 0,
                      closeAuthorityOption: tokenAccount.accountInfo.closeAuthorityOption === 1 ? 1 : 0,
                    });
                  }
                }
              })
              .catch((e) => {
                console.log(e);
                logger.warn('TX hash expired, hopefully we didnt crash');
                lastRequest = undefined;
                wsPairs?.close();
                processingToken = false;
              });
          } catch (e) {
            logger.warn('Buy failed');
            console.error(e);
            processingToken = false;
            lastRequest = undefined;
            wsPairs?.close();
            return;
          }
        }
      }
    } catch (e) {
      console.log(messageStr);

      console.error('Failed to parse JSON:', e);
      processingToken = false;
      setupLiquiditySocket();
    }
  });
  ws.on('error', function error(err) {
    console.error('WebSocket error:', err);
  });
  ws.on('close', async function close() {
    processingToken = false;
    logger.warn('WebSocket is closed liquidity');
    await new Promise((resolve) => setTimeout(resolve, 200));
    setupLiquiditySocket();
  });
}

function setupPairSocket() {
  wsPairs = new WebSocket(process.env.GEYSER_ENDPOINT!);
  wsPairs.on('open', function open() {
    if (lastRequest) {
      lastRequest = {
        jsonrpc: '2.0',
        id: 420,
        method: 'transactionSubscribe',
        params: [
          {
            vote: false,
            failed: false,
            accountInclude: [currentTokenKey],
          },
          {
            commitment: 'processed',
            encoding: 'jsonParsed',
            transactionDetails: 'full',
            showRewards: false,
            maxSupportedTransactionVersion: 1,
          },
        ],
      };
      wsPairs!.send(JSON.stringify(lastRequest));
    }
  });
  wsPairs.on('message', async function incoming(data) {
    const messageStr = data.toString();
    try {
      var jData = JSON.parse(messageStr);
      const instructionWithSwapSell = jData?.params?.result?.transaction?.meta?.innerInstructions[0];
      if (instructionWithSwapSell !== undefined) {
        getSwappedAmounts(instructionWithSwapSell);
      }
      const instructionWithSwapBuy =
        jData?.params?.result?.transaction?.meta?.innerInstructions[
          jData?.params?.result?.transaction?.meta?.innerInstructions.length - 1
        ];
      if (instructionWithSwapBuy !== undefined) {
        getSwappedAmounts(instructionWithSwapBuy);
      }
      const instructionWithSwapBuy2 =
        jData?.params?.result?.transaction?.meta?.innerInstructions[
          jData?.params?.result?.transaction?.meta?.innerInstructions.length - 2
        ];
      if (instructionWithSwapBuy2 !== undefined) {
        getSwappedAmounts(instructionWithSwapBuy2);
      }
    } catch (e) {
      console.log(messageStr);
      console.error('Failed to parse JSON:', e);
      if (foundTokenData) sellOnActionGeyser(foundTokenData);
      setupPairSocket();
    }
  });
  wsPairs.on('error', function error(err) {
    console.error('WebSocket error:', err);
  });
  wsPairs.on('close', async function close() {
    logger.warn('WebSocket is closed pair');

    // throw 'Websocket closed';
    await new Promise((resolve) => setTimeout(resolve, 200));
    setupPairSocket();
  });
}

async function getSwappedAmounts(instructionWithSwap: any) {
  if (!foundTokenData) return;
  const swapDataBuy = instructionWithSwap.instructions?.filter((x: any) => x.parsed?.info.amount !== undefined);
  if (swapDataBuy !== undefined) {
    const sol = swapDataBuy.find(
      (x: any) => x.parsed.info.authority !== '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
    );
    if (sol) {
      const other = swapDataBuy.find(
        (x: any) => x.parsed.info.authority === '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
      );
      if (foundTokenData) {
        if (sol === undefined || other === undefined) {
          logger.warn(`Geyser is broken, selling`);
          sellOnActionGeyser(foundTokenData!);
          return;
        }
        if (new Date() >= timeToSellTimeoutGeyser!) {
          if (!foundTokenData) return;
          logger.info(`Selling at TIMEOUT, change addr ${foundTokenData!.mint.toString()}`);
          await sellOnActionGeyser(foundTokenData!);
          return;
        }
        let price = BigNumber(sol.parsed.info.amount as string).div(other.parsed.info.amount as string);
        const isSolSwapped = price.gt(1);
        if (isSolSwapped) price = BigNumber(other.parsed.info.amount as string).div(sol.parsed.info.amount as string);
        if (!bignumberInitialPrice) {
          bignumberInitialPrice = price;
          return;
        }

        const percentageGain = price.minus(bignumberInitialPrice).div(bignumberInitialPrice).multipliedBy(100);
        let percentageGainNumber = Number(percentageGain.toFixed(5));

        if (Number(percentageGain.toFixed(5)) < 0) logger.warn(percentageGain.toString());
        else logger.info(percentageGain.toString());

        if (percentageGainNumber <= stopLossPrecents) {
          if (!foundTokenData) return;
          logger.warn(`Selling at LOSS, loss ${percentageGainNumber}%, addr ${foundTokenData!.mint.toString()}`);
          await sellOnActionGeyser(foundTokenData!);
          return;
        }
        if (percentageGainNumber >= takeProfitPercents) {
          if (!foundTokenData) return;
          logger.info(
            `Selling at TAKEPROFIT, increase ${percentageGainNumber}%, addr ${foundTokenData!.mint.toString()}`,
          );
          await sellOnActionGeyser(foundTokenData!);

          return;
        }
      }
    }
  }
}

async function sellOnActionGeyser(account: RawAccount) {
  bignumberInitialPrice = undefined;
  foundTokenData = undefined;
  const signature = await sell(
    account.mint,
    account.amount,
    existingTokenAccountsExtended,
    quoteTokenAssociatedAddress,
  );
  if (signature) {
    solanaConnection
      .confirmTransaction(signature as TransactionConfirmationStrategy, 'finalized')
      .then(async (confirmation) => {
        if (confirmation.value.err) {
          logger.warn('Sent sell but it failed');
          existingTokenAccounts = await getTokenAccounts(
            solanaConnection,
            wallet.publicKey,
            process.env.COMMITMENT as Commitment,
          );
          const tokenAccount = existingTokenAccounts.find(
            (acc) => acc.accountInfo.mint.toString() === account.mint.toString(),
          )!;
          const signature = await sell(
            account.mint,
            tokenAccount.accountInfo.amount,
            existingTokenAccountsExtended,
            quoteTokenAssociatedAddress,
          );
          clearAfterSell();
        } else {
          logger.info('Sell success');
          clearAfterSell();
        }
      })
      .catch(async (e) => {
        console.log(e);
        logger.warn('Sell TX hash expired, hopefully we didnt crash');
        const signature = await sell(
          account.mint,
          account.amount,
          existingTokenAccountsExtended,
          quoteTokenAssociatedAddress,
        );
        clearAfterSell();
      });
  }
}

function clearAfterSell() {
  lastRequest = undefined;
  wsPairs?.close();
  gotWalletToken = false;
  processingToken = false;
  currentTokenSwaps++;
  if (currentTokenSwaps > 0) {
    exit();
  }
}

export async function processGeyserLiquidity(
  id: PublicKey,
  poolState: LiquidityStateV4,
  mint: PublicKey,
): Promise<TransactionConfirmationStrategy> {
  const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);
  logger.info(`Processing pool: ${mint.toString()} with ${poolSize.toFixed()} ${quoteToken.symbol} in liquidity`);
  if (Number(poolSize.toFixed()) < 0.4) throw 'Pool too low';
  const block = await getBlockForBuy();
  logger.info(`Got block`);

  const packet = await buy(
    id,
    poolState,
    existingTokenAccountsExtended,
    quoteTokenAssociatedAddress,
    currentLamports,
    mint,
    block,
  );
  return packet;
}

async function listenToChanges() {
  const walletSubscriptionId = solanaConnection.onProgramAccountChange(
    TOKEN_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data);
      if (accountData.mint.toString() === quoteToken.mint.toString()) {
        const walletBalance = new TokenAmount(Token.WSOL, accountData.amount, true);
        logger.info('WSOL amount change ' + walletBalance.toFixed(4));
        sendMessage(`💸WSOL change ${walletBalance.toFixed(4)} ${currentTokenKey}`);
        return;
      }
      if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) {
        return;
      }
      if (currentTokenKey !== accountData.mint.toString()) {
        console.log(currentTokenKey, accountData.mint.toString());
        logger.warn('Got unknown token in wallet');
        return;
      }
      if (gotWalletToken) return;
      gotWalletToken = true;
      logger.info(`Monitoring`);
      console.log(accountData.mint);
      foundTokenData = accountData;
      const now = new Date();
      if (now.getTime() - sentBuyTime!.getTime() > 20 * 1000) {
        logger.warn('Buy took too long, selling');
        await sellOnActionGeyser(foundTokenData!);
        return;
      }
      timeToSellTimeoutGeyser = new Date();
      timeToSellTimeoutGeyser.setTime(timeToSellTimeoutGeyser.getTime() + timoutSec * 1000);
    },
    'processed' as Commitment,
    [
      {
        dataSize: 165,
      },
      {
        memcmp: {
          offset: 32,
          bytes: wallet.publicKey.toBase58(),
        },
      },
    ],
  );
}
