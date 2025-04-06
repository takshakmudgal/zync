"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/trpc/react";
import { useUser } from "@/hooks/use-user";
import { agentToast } from "./agent-toast";
import { useDialogStore } from "@/store/dialog-store";
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import type { Agent } from "@/types/agent";

// Add type for injected wallet
declare global {
  interface Window {
    solana?: {
      signTransaction(transaction: Transaction): Promise<Transaction>;
    };
  }
}

export function CreateBackroomForm() {
  const router = useRouter();
  const { publicKey } = useUser();
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [paidAgents, setPaidAgents] = useState<Record<string, Agent>>({});
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [currentPaymentAgentId, setCurrentPaymentAgentId] = useState<
    string | null
  >(null);

  // Add a new state to track agents that have been paid for
  const [paidForAgents, setPaidForAgents] = useState<Record<string, boolean>>(
    {},
  );

  const [formData, setFormData] = useState({
    name: "",
    topic: "",
    description: "",
    messageLimit: 20,
    visibility: "private" as "public" | "private",
  });

  const agentsQuery = api.r2.listAgents.useQuery(
    {
      limit: 1000,
      creator: publicKey ?? undefined,
    },
    {
      enabled: !!publicKey,
      refetchOnWindowFocus: true,
    },
  );

  // Separate query for getting all available agents (including public ones)
  const createBackroom = api.r2.createBackroom.useMutation({
    onSuccess: (result) => {
      router.refresh();
      const store = useDialogStore.getState();
      store.updateDialogView("BACKROOMS", {
        id: "BACKROOM_DETAIL",
        title: formData.name,
        data: { id: result.backroomId },
      });
      agentToast.success("Backroom created!");
    },
  });

  // Update the useEffect to check payment status for paid agents
  useEffect(() => {
    if (agentsQuery.data?.agents && publicKey) {
      const paidAgentsMap: Record<string, Agent> = {};

      for (const agent of agentsQuery.data.agents) {
        if (
          agent.visibility === "public" &&
          agent.price &&
          agent.price > 0 &&
          agent.creator !== publicKey
        ) {
          paidAgentsMap[agent.id] = agent;
        }
      }

      setPaidAgents(paidAgentsMap);
    }
  }, [agentsQuery.data?.agents, publicKey]);

  // When an agent is successfully paid for, add it to the paidForAgents
  const verifyPayment = api.payment.verifyPayment.useMutation({
    onSuccess: () => {
      agentToast.success("Payment verified successfully!");

      // Add the agent to the selected agents
      if (currentPaymentAgentId) {
        setSelectedAgents((prev) => [...prev, currentPaymentAgentId]);

        // Mark this agent as paid for
        setPaidForAgents((prev) => ({
          ...prev,
          [currentPaymentAgentId]: true,
        }));
      }

      setIsProcessingPayment(false);
      setCurrentPaymentAgentId(null);
    },
    onError: (error) => {
      agentToast.error("Payment verification failed: " + error.message);
      setIsProcessingPayment(false);
      setCurrentPaymentAgentId(null);
    },
  });

  const handlePayment = async (agentId: string) => {
    if (!publicKey || !paidAgents[agentId]?.price) {
      return;
    }

    try {
      setIsProcessingPayment(true);
      setCurrentPaymentAgentId(agentId);

      // Create a Solana connection
      const connection = new Connection(
        "https://mainnet.helius-rpc.com/?api-key=a018a555-b435-4629-a61b-6e001431ca58",
        {
          commitment: "confirmed",
        },
      );

      // Setup transaction
      const creatorPublicKey = new PublicKey(paidAgents[agentId].creator);
      const senderPublicKey = new PublicKey(publicKey);
      const lamportsToSend = Math.round(
        paidAgents[agentId].price * LAMPORTS_PER_SOL,
      );

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: senderPublicKey,
          toPubkey: creatorPublicKey,
          lamports: lamportsToSend,
        }),
      );

      // Set recent blockhash and fee payer
      transaction.recentBlockhash = (
        await connection.getLatestBlockhash()
      ).blockhash;
      transaction.feePayer = senderPublicKey;

      // Request wallet signature
      if (!window.solana) {
        setIsProcessingPayment(false);
        setCurrentPaymentAgentId(null);
        throw new Error("Solana wallet not found!");
      }

      let signedTransaction;
      try {
        signedTransaction = await window.solana.signTransaction(transaction);
      } catch (error) {
        // Clean up state
        setIsProcessingPayment(false);
        setCurrentPaymentAgentId(null);

        // Handle transaction rejection without logging to console
        if (
          error instanceof Error &&
          (error.message.includes("rejected") ||
            error.message.includes("User rejected"))
        ) {
          agentToast.info("Transaction was cancelled by user");
          return; // Exit without throwing further
        }

        // For other errors, throw to be caught by outer catch
        throw error;
      }

      // Send transaction
      const signature = await connection.sendRawTransaction(
        signedTransaction.serialize(),
      );

      // Verify transaction on the server
      await verifyPayment.mutateAsync({
        signature,
        payerPublicKey: publicKey,
        recipient: paidAgents[agentId].creator,
        agentId,
      });
    } catch (error) {
      // Clean up state
      setIsProcessingPayment(false);
      setCurrentPaymentAgentId(null);

      // Only show toast notification, avoid console.error
      if (
        error instanceof Error &&
        (error.message.includes("rejected") ||
          error.message.includes("User rejected"))
      ) {
        agentToast.info("Transaction was cancelled by user");
      } else {
        agentToast.error("Payment failed");
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      if (!publicKey) {
        agentToast.walletRequired("Connect wallet to create backrooms");
        return;
      }
      if (selectedAgents.length < 2) {
        agentToast.error("Please select at least 2 agents");
        return;
      }
      if (selectedAgents.length > 8) {
        agentToast.error("Maximum 8 agents allowed");
        return;
      }

      await createBackroom.mutateAsync({
        ...formData,
        agents: selectedAgents,
        creator: publicKey,
      });
    } catch (error) {
      // Remove console.error and just show toast
      agentToast.error(
        "Failed to create backroom: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  };

  const handleAgentSelect = async (agentId: string) => {
    try {
      if (!publicKey) {
        agentToast.walletRequired("Connect wallet to select agents");
        return;
      }

      if (selectedAgents.includes(agentId)) {
        setSelectedAgents((prev) => prev.filter((id) => id !== agentId));
        return;
      }

      if (selectedAgents.length >= 8) {
        agentToast.error("Maximum 8 agents allowed");
        return;
      }

      const agentToAdd = agentsQuery.data?.agents.find((a) => a.id === agentId);
      if (!agentToAdd) {
        agentToast.error("Agent not found");
        return;
      }

      // Check if the agent can launch tokens
      if (agentToAdd?.canLaunchToken) {
        // Check if there's already an agent with token launching capability
        const hasTokenLaunchingAgent = selectedAgents.some((id) => {
          const agent = agentsQuery.data?.agents.find((a) => a.id === id);
          return agent?.canLaunchToken;
        });

        if (hasTokenLaunchingAgent) {
          agentToast.error(
            "Only one agent with token launching capability can be added to a backroom",
          );
          return;
        }
      }

      // Check if this is a paid agent that we need to pay for
      const isPaidAgent = paidAgents[agentId] !== undefined;
      const alreadyPaidFor = paidForAgents[agentId];

      // If it's a paid agent and not already paid for
      if (
        isPaidAgent &&
        !alreadyPaidFor &&
        paidAgents[agentId].creator !== publicKey
      ) {
        // Process payment first
        await handlePayment(agentId);
        // After payment completes, the verifyPayment.onSuccess callback will be called
        // and add the agent to selectedAgents
      } else {
        // For free agents, if user is the creator, or already paid, add immediately
        setSelectedAgents((prev) => [...prev, agentId]);
      }
    } catch (error) {
      // Don't log error to console
      setIsProcessingPayment(false);
      setCurrentPaymentAgentId(null);

      // Check for wallet rejection errors specifically
      if (
        error instanceof Error &&
        (error.message.includes("rejected") ||
          error.message.includes("User rejected"))
      ) {
        agentToast.info("Transaction was cancelled by user");
      } else {
        // Handle other errors with a simple message
        agentToast.error("Failed to select agent");
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <label>Name</label>
          <input
            required
            className="w-full rounded border border-gray-300 bg-white p-1 shadow-[inset_1px_1px_#0a0a0a,inset_-1px_-1px_#fff]"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label>Message Limit</label>
          <select
            className="w-full rounded border border-gray-300 bg-white p-1 shadow-[inset_1px_1px_#0a0a0a,inset_-1px_-1px_#fff]"
            value={formData.messageLimit}
            onChange={(e) =>
              setFormData({ ...formData, messageLimit: Number(e.target.value) })
            }
          >
            <option value={10}>10 Messages</option>
            <option value={20}>20 Messages</option>
            <option value={30}>30 Messages</option>
            <option value={40}>40 Messages</option>
            <option value={50}>50 Messages</option>
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label>Topic</label>
        <input
          required
          className="w-full rounded border border-gray-300 bg-white p-1 shadow-[inset_1px_1px_#0a0a0a,inset_-1px_-1px_#fff]"
          value={formData.topic}
          onChange={(e) => setFormData({ ...formData, topic: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label>Description</label>
        <textarea
          required
          className="w-full rounded border border-gray-300 bg-white p-1 shadow-[inset_1px_1px_#0a0a0a,inset_-1px_-1px_#fff]"
          rows={3}
          value={formData.description}
          onChange={(e) =>
            setFormData({ ...formData, description: e.target.value })
          }
        />
      </div>

      <div className="flex flex-col gap-1">
        <label>Select Agents (2-8 required)</label>
        <div className="grid grid-cols-2 gap-2">
          {agentsQuery.isLoading && (
            <div className="col-span-2 text-center text-sm text-gray-600">
              Loading agents...
            </div>
          )}

          {agentsQuery.data?.agents.map((agent) => {
            const isPaid = agent.price && agent.price > 0;
            const isPublic = agent.visibility === "public";
            const isPaidAgent = isPaid && isPublic;
            const isCreatorOfAgent = agent.creator === publicKey;
            const isProcessingThisAgent =
              isProcessingPayment && currentPaymentAgentId === agent.id;
            const alreadyPaidFor = paidForAgents[agent.id];

            return (
              <div
                key={agent.id}
                onClick={async () => {
                  if (isProcessingPayment) return;
                  try {
                    await handleAgentSelect(agent.id);
                  } catch (_error) {
                    /* eslint-disable-line @typescript-eslint/no-unused-vars */
                    // Errors are already handled in handleAgentSelect
                    // Don't log errors to console
                  }
                }}
                className={`cursor-pointer rounded border p-2 ${
                  selectedAgents.includes(agent.id)
                    ? "border-blue-500 bg-blue-50 shadow-[inset_1px_1px_#0a0a0a,inset_-1px_-1px_#fff]"
                    : "shadow-[inset_-1px_-1px_#0a0a0a,inset_1px_1px_#fff] hover:bg-gray-50"
                } ${isProcessingPayment ? "opacity-50" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium">{agent.name}</p>
                  <div className="flex items-center gap-1">
                    {agent.visibility === "private" && (
                      <span className="rounded bg-gray-100 px-1 text-xs text-gray-600">
                        Private
                      </span>
                    )}
                    {isCreatorOfAgent && (
                      <span className="rounded bg-yellow-100 px-1 text-xs text-yellow-600">
                        Your Agent
                      </span>
                    )}
                    {isPaidAgent && !isCreatorOfAgent && (
                      <span
                        className={`rounded px-1 text-xs ${
                          alreadyPaidFor
                            ? "bg-blue-100 text-blue-600"
                            : "bg-green-100 text-green-600"
                        }`}
                      >
                        {alreadyPaidFor ? "Paid" : `${agent.price} SOL`}
                      </span>
                    )}
                    {agent.canLaunchToken && (
                      <span className="rounded bg-purple-100 px-1 text-xs text-purple-600">
                        Token Launcher
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-xs text-gray-600">{agent.type}</p>
                {isProcessingThisAgent && (
                  <p className="mt-1 text-xs text-blue-500">
                    Processing payment...
                  </p>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-gray-600">
          Selected: {selectedAgents.length} agents
        </p>
      </div>

      <div className="flex justify-between pt-4">
        <select
          className="rounded border border-gray-300 bg-white p-1 shadow-[inset_1px_1px_#0a0a0a,inset_-1px_-1px_#fff]"
          value={formData.visibility}
          onChange={(e) =>
            setFormData({
              ...formData,
              visibility: e.target.value as "public" | "private",
            })
          }
        >
          <option value="private">Private</option>
          <option value="public">Public</option>
        </select>

        <button
          type="submit"
          className="rounded border border-black bg-[#00009e] px-4 py-2 text-sm text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
          disabled={createBackroom.isPending || isProcessingPayment}
        >
          {createBackroom.isPending
            ? "Creating..."
            : isProcessingPayment
              ? "Processing Payment..."
              : "Create Backroom"}
        </button>
      </div>
    </form>
  );
}
