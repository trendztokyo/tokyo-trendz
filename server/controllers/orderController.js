const db = require("../config/db");
const { createNotification } = require("../utils/notificationHelper");
function createOrder(req, res) {
    const userId = req.user.userId;

    const {
        fullName,
        phone,
        address,
        city,
        state,
        postalCode,
        landmark,
        couponCode
    } = req.body;

    if (
        !fullName ||
        !phone ||
        !address ||
        !city ||
        !state ||
        !postalCode
    ) {
        return res.status(400).json({
            success: false,
            message: "Please fill all required address fields"
        });
    }

    const connection = db;

    connection.beginTransaction((transactionError) => {
        if (transactionError) {
            console.error(
                "Transaction start error:",
                transactionError
            );

            return res.status(500).json({
                success: false,
                message: "Unable to start order"
            });
        }

        const cartSql = `
            SELECT
                ci.id AS cart_item_id,
                ci.product_id,
                ci.variant_id,
                ci.quantity,
                p.name AS product_name,
                COALESCE(p.discount_price, p.price) AS price,
                pv.size,
                pv.color
            FROM cart_items ci
            INNER JOIN cart c
                ON ci.cart_id = c.id
            INNER JOIN products p
                ON ci.product_id = p.id
            INNER JOIN product_variants pv
                ON ci.variant_id = pv.id
            WHERE c.user_id = ?
        `;

        connection.query(
            cartSql,
            [userId],
            (cartError, cartItems) => {
                if (cartError) {
                    return rollbackOrder(
                        connection,
                        res,
                        cartError,
                        "Unable to read cart"
                    );
                }

                if (cartItems.length === 0) {
                    return rollbackOrder(
                        connection,
                        res,
                        null,
                        "Your cart is empty",
                        400
                    );
                }

                let subtotal = 0;

                cartItems.forEach((item) => {
                    subtotal +=
                        Number(item.price) *
                        Number(item.quantity);
                });

                const shippingFee = 0;

                /*
                 * Coupon validation
                 * -----------------
                 * The frontend coupon discount is NOT trusted.
                 * We validate the coupon again inside the order
                 * transaction before creating the order.
                 */

                const applyOrder = (
                    discount,
                    usedCouponId
                ) => {
                    const totalAmount =
                        subtotal -
                        discount +
                        shippingFee;

                    const insertAddressSql = `
                        INSERT INTO addresses (
                            user_id,
                            full_name,
                            phone,
                            address_line,
                            city,
                            state,
                            postal_code,
                            country,
                            is_default
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'India', 0)
                    `;

                    const addressLine = landmark
                        ? `${address}, ${landmark}`
                        : address;

                    connection.query(
                        insertAddressSql,
                        [
                            userId,
                            fullName,
                            phone,
                            addressLine,
                            city,
                            state,
                            postalCode
                        ],
                        (addressError, addressResult) => {
                            if (addressError) {
                                return rollbackOrder(
                                    connection,
                                    res,
                                    addressError,
                                    "Unable to save delivery address"
                                );
                            }

                            const addressId =
                                addressResult.insertId;

                            const orderNumber =
                                `TT-${Date.now()}-${userId}`;

                            const insertOrderSql = `
                                INSERT INTO orders (
                                    user_id,
                                    address_id,
                                    order_number,
                                    subtotal,
                                    discount,
                                    shipping_fee,
                                    total_amount,
                                    payment_method,
                                    payment_status,
                                    order_status
                                )
                                VALUES (?, ?, ?, ?, ?, ?, ?, 'cod', 'pending', 'placed')
                            `;

                            connection.query(
                                insertOrderSql,
                                [
                                    userId,
                                    addressId,
                                    orderNumber,
                                    subtotal,
                                    discount,
                                    shippingFee,
                                    totalAmount
                                ],
                                (orderError, orderResult) => {
                                    if (orderError) {
                                        return rollbackOrder(
                                            connection,
                                            res,
                                            orderError,
                                            "Unable to create order"
                                        );
                                    }

                                    const orderId =
                                        orderResult.insertId;

                                    const insertItemSql = `
                                        INSERT INTO order_items (
                                            order_id,
                                            product_id,
                                            variant_id,
                                            product_name,
                                            size,
                                            color,
                                            quantity,
                                            price
                                        )
                                        VALUES ?
                                    `;

                                    const orderItemValues =
                                        cartItems.map((item) => [
                                            orderId,
                                            item.product_id,
                                            item.variant_id,
                                            item.product_name,
                                            item.size,
                                            item.color,
                                            item.quantity,
                                            item.price
                                        ]);

                                    connection.query(
                                        insertItemSql,
                                        [orderItemValues],
                                        (itemsError) => {
                                            if (itemsError) {
                                                return rollbackOrder(
                                                    connection,
                                                    res,
                                                    itemsError,
                                                    "Unable to create order items"
                                                );
                                            }

                                            const clearCartSql = `
                                                DELETE ci
                                                FROM cart_items ci
                                                INNER JOIN cart c
                                                    ON ci.cart_id = c.id
                                                WHERE c.user_id = ?
                                            `;

                                            connection.query(
                                                clearCartSql,
                                                [userId],
                                                (clearError) => {
                                                    if (clearError) {
                                                        return rollbackOrder(
                                                            connection,
                                                            res,
                                                            clearError,
                                                            "Unable to clear cart"
                                                        );
                                                    }

                                                    const finishOrder = () => {
                                                        /*
                                                         * Create customer notification
                                                         * inside the same transaction.
                                                         */
                                                        const notificationSql = `
                                                            INSERT INTO notifications (
                                                                user_id,
                                                                type,
                                                                title,
                                                                message
                                                            )
                                                            VALUES (?, ?, ?, ?)
                                                        `;

                                                        const notificationMessage =
                                                            `Your order ${orderNumber} has been placed successfully.`;

                                                        connection.query(
                                                            notificationSql,
                                                            [
                                                                userId,
                                                                "order_placed",
                                                                "Order Placed",
                                                                notificationMessage
                                                            ],
                                                            (notificationError) => {
                                                                if (notificationError) {
                                                                    return rollbackOrder(
                                                                        connection,
                                                                        res,
                                                                        notificationError,
                                                                        "Unable to create order notification"
                                                                    );
                                                                }

                                                                connection.commit(
                                                                    (commitError) => {
                                                                        if (commitError) {
                                                                            return rollbackOrder(
                                                                                connection,
                                                                                res,
                                                                                commitError,
                                                                                "Unable to complete order"
                                                                            );
                                                                        }

                                                                        return res
                                                                            .status(201)
                                                                            .json({
                                                                                success: true,
                                                                                message:
                                                                                    "Order placed successfully",
                                                                                order: {
                                                                                    id: orderId,
                                                                                    orderNumber,
                                                                                    subtotal,
                                                                                    discount,
                                                                                    shippingFee,
                                                                                    totalAmount,
                                                                                    paymentMethod:
                                                                                        "cod",
                                                                                    paymentStatus:
                                                                                        "pending",
                                                                                    orderStatus:
                                                                                        "placed"
                                                                                }
                                                                            });
                                                                    }
                                                                );
                                                            }
                                                        );
                                                    };

                                                    /*
                                                     * Increment coupon usage
                                                     * only after the order has
                                                     * been successfully created
                                                     * and cart has been cleared.
                                                     */

                                                    if (usedCouponId) {
                                                        const updateCouponSql = `
                                                            UPDATE coupons
                                                            SET used_count = used_count + 1
                                                            WHERE id = ?
                                                        `;

                                                        connection.query(
                                                            updateCouponSql,
                                                            [usedCouponId],
                                                            (couponUpdateError) => {
                                                                if (
                                                                    couponUpdateError
                                                                ) {
                                                                    return rollbackOrder(
                                                                        connection,
                                                                        res,
                                                                        couponUpdateError,
                                                                        "Unable to update coupon usage"
                                                                    );
                                                                }

                                                                finishOrder();
                                                            }
                                                        );
                                                    } else {
                                                        finishOrder();
                                                    }
                                                }
                                            );
                                        }
                                    );
                                }
                            );
                        }
                    );
                };

                /*
                 * No coupon supplied
                 */

                if (!couponCode || !couponCode.trim()) {
                    return applyOrder(0, null);
                }

                const normalizedCouponCode =
                    couponCode.trim().toUpperCase();

                /*
                 * FOR UPDATE locks the coupon row while
                 * this order transaction is running.
                 */

                const couponSql = `
                    SELECT
                        id,
                        code,
                        discount_type,
                        discount_value,
                        minimum_order_amount,
                        maximum_discount,
                        expiry_date,
                        usage_limit,
                        used_count,
                        is_active
                    FROM coupons
                    WHERE code = ?
                    LIMIT 1
                    FOR UPDATE
                `;

                connection.query(
                    couponSql,
                    [normalizedCouponCode],
                    (couponError, coupons) => {
                        if (couponError) {
                            return rollbackOrder(
                                connection,
                                res,
                                couponError,
                                "Unable to validate coupon"
                            );
                        }

                        if (coupons.length === 0) {
                            return rollbackOrder(
                                connection,
                                res,
                                null,
                                "Invalid coupon code",
                                400
                            );
                        }

                        const coupon = coupons[0];

                        if (!coupon.is_active) {
                            return rollbackOrder(
                                connection,
                                res,
                                null,
                                "This coupon is inactive",
                                400
                            );
                        }

                        if (
                            new Date(coupon.expiry_date) <=
                            new Date()
                        ) {
                            return rollbackOrder(
                                connection,
                                res,
                                null,
                                "This coupon has expired",
                                400
                            );
                        }

                        if (
                            coupon.usage_limit !== null &&
                            Number(coupon.used_count) >=
                            Number(coupon.usage_limit)
                        ) {
                            return rollbackOrder(
                                connection,
                                res,
                                null,
                                "This coupon usage limit has been reached",
                                400
                            );
                        }

                        if (
                            subtotal <
                            Number(coupon.minimum_order_amount)
                        ) {
                            return rollbackOrder(
                                connection,
                                res,
                                null,
                                `Minimum order amount is ₹${Number(
                                    coupon.minimum_order_amount
                                ).toFixed(2)}`,
                                400
                            );
                        }

                        let discount = 0;

                        if (
                            coupon.discount_type ===
                            "percentage"
                        ) {
                            discount =
                                subtotal *
                                (
                                    Number(
                                        coupon.discount_value
                                    ) / 100
                                );
                        } else if (
                            coupon.discount_type ===
                            "fixed"
                        ) {
                            discount =
                                Number(
                                    coupon.discount_value
                                );
                        }

                        if (
                            coupon.maximum_discount !== null &&
                            Number(coupon.maximum_discount) > 0
                        ) {
                            discount = Math.min(
                                discount,
                                Number(
                                    coupon.maximum_discount
                                )
                            );
                        }

                        discount = Math.min(
                            discount,
                            subtotal
                        );

                        discount = Number(
                            discount.toFixed(2)
                        );

                        return applyOrder(
                            discount,
                            coupon.id
                        );
                    }
                );
            }
        );
    });
}


function getOrders(req, res) {
    const userId = req.user.userId;

    const sql = `
        SELECT
            o.id,
            o.order_number,
            o.subtotal,
            o.discount,
            o.shipping_fee,
            o.total_amount,
            o.payment_method,
            o.payment_status,
            o.order_status,
            o.created_at,
            a.full_name,
            a.phone,
            a.address_line,
            a.city,
            a.state,
            a.postal_code,
            a.country,
            oi.id AS order_item_id,
            oi.product_id,
            oi.variant_id,
            oi.product_name,
            oi.size,
            oi.color,
            oi.quantity,
            oi.price
        FROM orders o
        INNER JOIN addresses a
            ON o.address_id = a.id
        INNER JOIN order_items oi
            ON o.id = oi.order_id
        WHERE o.user_id = ?
        ORDER BY
            o.created_at DESC,
            oi.id ASC
    `;

    db.query(
        sql,
        [userId],
        (error, results) => {
            if (error) {
                console.error(
                    "Get orders error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to fetch orders"
                });
            }

            const ordersMap = {};

            results.forEach((row) => {
                if (!ordersMap[row.id]) {
                    ordersMap[row.id] = {
                        id: row.id,
                        orderNumber: row.order_number,
                        subtotal: Number(row.subtotal),
                        discount: Number(row.discount),
                        shippingFee: Number(row.shipping_fee),
                        totalAmount: Number(row.total_amount),
                        paymentMethod: row.payment_method,
                        paymentStatus: row.payment_status,
                        orderStatus: row.order_status,
                        createdAt: row.created_at,
                        address: {
                            fullName: row.full_name,
                            phone: row.phone,
                            addressLine: row.address_line,
                            city: row.city,
                            state: row.state,
                            postalCode: row.postal_code,
                            country: row.country
                        },
                        items: []
                    };
                }

                ordersMap[row.id].items.push({
                    id: row.order_item_id,
                    productId: row.product_id,
                    variantId: row.variant_id,
                    productName: row.product_name,
                    size: row.size,
                    color: row.color,
                    quantity: row.quantity,
                    price: Number(row.price)
                });
            });

            const orders = Object.values(
                ordersMap
            );

            return res.json({
                success: true,
                orders
            });
        }
    );
}


function rollbackOrder(
    connection,
    res,
    error,
    message,
    statusCode = 500
) {
    if (error) {
        console.error(
            "Order error:",
            error
        );
    }

    connection.rollback(() => {
        return res.status(statusCode).json({
            success: false,
            message
        });
    });
}


function cancelOrder(req, res) {
    const userId = req.user.userId;
    const orderId = req.params.orderId;

    const getOrderSql = `
        SELECT
            id,
            order_number
        FROM orders
        WHERE id = ?
        AND user_id = ?
        AND order_status = 'placed'
    `;

    db.query(
        getOrderSql,
        [orderId, userId],
        (orderError, orders) => {
            if (orderError) {
                console.error(
                    "Get order for cancellation error:",
                    orderError
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to cancel order"
                });
            }

            if (orders.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "Order cannot be cancelled"
                });
            }

            const order = orders[0];

            const updateSql = `
                UPDATE orders
                SET order_status = 'cancelled'
                WHERE id = ?
                AND user_id = ?
                AND order_status = 'placed'
            `;

            db.query(
                updateSql,
                [orderId, userId],
                async (error, result) => {
                    if (error) {
                        console.error(
                            "Cancel order error:",
                            error
                        );

                        return res.status(500).json({
                            success: false,
                            message: "Unable to cancel order"
                        });
                    }

                    if (result.affectedRows === 0) {
                        return res.status(400).json({
                            success: false,
                            message: "Order cannot be cancelled"
                        });
                    }

                    // Create customer cancellation notification
                    await createNotification(
                        userId,
                        "order_status",
                        "Order Cancelled",
                        `Your order ${order.order_number} has been cancelled.`
                    );

                    return res.json({
                        success: true,
                        message: "Order cancelled successfully"
                    });
                }
            );
        }
    );
}

module.exports = {
    createOrder,
    getOrders,
    cancelOrder
};