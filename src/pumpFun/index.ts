import {
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  Commitment,
  Finality,
  Transaction,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  PriorityFee,
  DEFAULT_COMMITMENT,
  DEFAULT_FINALITY,
  TransactionResult,
  sendTx,
  calculateWithSlippageBuy,
  GlobalAccount,
} from 'pumpdotfun-sdk';
import { Program, Provider } from '@coral-xyz/anchor';
import { IDL, PumpFun } from './IDL';
import { wallet, solanaConnection } from '../solana';
import logger from '../utils/logger';
import { Block } from '../listener.types';
import { getRandomAccount } from '../jito/constants';
import { sendBundles } from '../jito/bundles';
const BN = require('bn.js');
const tipAmount = Number(process.env.JITO_TIP!);
//13814844391485 for 0.4 after 0.33b

async function sendJitoTx(transaction: VersionedTransaction) {
  // Serialize transaction to Base64
  const serializedTransaction = transaction.serialize();
  const transactionBuffer = Buffer.from(serializedTransaction);

  const base64Transaction = transactionBuffer.toString('base64');

  // Prepare JSON payload for Jito Block Engine API
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: [base64Transaction],
  };

  // Send transaction to Jito Block Engine API
  const response = await fetch('https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  console.log(response.ok);
  console.log(response);
  console.log(await response.json());
}

export async function buyPump(
  buyer: Keypair,
  mint: PublicKey,
  buyAmountSol: bigint,
  buyAmount: bigint,
  globalAccount: GlobalAccount,
  provider: Provider,
  associatedBondingCurve: PublicKey,
  block: Block,
) {
  let buyTx = await getBuyInstructions(
    buyer.publicKey,
    mint,
    globalAccount.feeRecipient,
    buyAmount,
    buyAmountSol + buyAmountSol / 100n, //1%
    provider,
    associatedBondingCurve,
  );

  // const tipAccount = getRandomAccount();

  // const tipInstruction = SystemProgram.transfer({
  //   fromPubkey: wallet.publicKey,
  //   toPubkey: tipAccount,
  //   lamports: tipAmount,
  // });

  // const bundleId = await sendBundles(wallet, transaction, block.blockhash);
  // console.log(bundleId);
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: block.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 13735111 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 72000 }),
      ...buyTx.instructions,
    ],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([wallet]);
  logger.info('sending');
  await sendJitoTx(transaction);
  // const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
  //   skipPreflight: true,
  // });
  // logger.info(signature);
  let initialPrice = 1020010;
  for (let i = 0; i < 3; i++) {
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: block.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: initialPrice - i * 100000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 72000 }),
        ...buyTx.instructions,
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);
    logger.info('sending');
    await sendJitoTx(transaction);
  }

  return;
}

export async function sellPump(
  buyer: Keypair,
  mint: PublicKey,
  sellAmount: bigint,
  globalAccount: GlobalAccount,
  provider: Provider,
  associatedBondingCurve: PublicKey,
  block: Block,
) {
  let sellTx = await getSellInstructions(
    buyer.publicKey,
    mint,
    globalAccount.feeRecipient,
    sellAmount,
    provider,
    associatedBondingCurve,
  );
  const tipAccount = getRandomAccount();

  const tipInstruction = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: tipAccount,
    lamports: tipAmount / 80,
  });
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: block.blockhash,
    instructions: [...sellTx.instructions, tipInstruction],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([wallet]);
  logger.info('selling');
  const bundleId = await sendBundles(wallet, transaction, block.blockhash);
  console.log(bundleId);

  return;
}

async function getBuyInstructions(
  buyer: PublicKey,
  mint: PublicKey,
  feeRecipient: PublicKey,
  amount: bigint,
  solAmount: bigint,
  provider: Provider,
  associatedBondingCurve: PublicKey,
) {
  const associatedUser = await getAssociatedTokenAddress(mint, buyer, false);

  let transaction = new Transaction();
  transaction.add(createAssociatedTokenAccountInstruction(buyer, associatedUser, buyer, mint));
  const program = new Program<PumpFun>(IDL as PumpFun, provider);

  transaction.add(
    await program.methods
      .buy(new BN(amount.toString()), new BN(solAmount.toString()))
      .accounts({
        feeRecipient: feeRecipient,
        mint: mint,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: associatedUser,
        user: buyer,
      })
      .transaction(),
  );

  return transaction;
}

async function getSellInstructions(
  seller: PublicKey,
  mint: PublicKey,
  feeRecipient: PublicKey,
  amount: bigint,
  provider: Provider,
  associatedBondingCurve: PublicKey,
) {
  const associatedUser = await getAssociatedTokenAddress(mint, seller, false);

  let transaction = new Transaction();
  const program = new Program<PumpFun>(IDL as PumpFun, provider);

  transaction.add(
    await program.methods
      .sell(new BN(amount.toString()), new BN('0'))
      .accounts({
        feeRecipient: feeRecipient,
        mint: mint,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: associatedUser,
        user: seller,
      })
      .transaction(),
  );

  return transaction;
}
